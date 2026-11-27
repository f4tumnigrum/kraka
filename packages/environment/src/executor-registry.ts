import * as v from "valibot";
import {
  canonicalJson,
  ExecutorInstanceSnapshotSchema,
  ObjectVersionSchema,
  StoredRegistrationSchema,
  REQUEST_METHODS,
  type CommandReceipt,
  type ExecutorInstanceId,
  type ObjectVersion,
  type PrincipalId,
  type SignedRequest,
} from "@kraka/protocol";
import type {
  CredentialBinding,
  ExecutorRegistration,
  ExecutorRegistry,
  InstanceProbe,
} from "./executor-records";
import { recordCommand, type FirstSendContext } from "./first-send";
import type { FirstSendStore } from "./first-send-store";

export class WriterExecutorRegistry implements ExecutorRegistry {
  private readonly probes = new Map<string, InstanceProbe>();
  private readonly targets = new Map<string, { cwd: string; token: symbol }>();
  constructor(readonly store: FirstSendStore) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS executor_registrations(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS executor_secrets(instance TEXT NOT NULL,binding TEXT NOT NULL,value TEXT NOT NULL, PRIMARY KEY(instance,binding));
      CREATE TABLE IF NOT EXISTS round_executors(round TEXT PRIMARY KEY,instance TEXT NOT NULL,version TEXT NOT NULL,model TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS project_executor_defaults(project TEXT PRIMARY KEY,instance TEXT NOT NULL);`);
  }
  // This host-only boundary records immutable scoped versions before a signed command can refer to them.
  storeSecret(instance: ExecutorInstanceId, binding: CredentialBinding, value: string) {
    const old = this.secret(instance, binding);
    if (old !== null && old !== value) throw new Error("Credential version conflict");
    this.store.db.run("INSERT OR IGNORE INTO executor_secrets VALUES(?,?,?)", [
      instance,
      canonicalJson(binding),
      value,
    ]);
  }
  private secret(instance: ExecutorInstanceId, binding: CredentialBinding) {
    return (
      this.store.db
        .query<{ value: string }, [string, string]>(
          "SELECT value FROM executor_secrets WHERE instance=? AND binding=?",
        )
        .get(instance, canonicalJson(binding))?.value ?? null
    );
  }
  environment(r: ExecutorRegistration) {
    const env: Record<string, string> = Object.create(null);
    for (const [name, variable] of Object.entries(r.driver.variables)) {
      const value =
        variable.kind === "literal" ? variable.value : this.secret(r.instanceId, variable.binding);
      if (value === null) throw new Error("Missing scoped credential");
      env[name] = value;
    }
    if (r.driver.configurationRoot) env.CODEX_HOME = r.driver.configurationRoot;
    return env;
  }
  current(id: ExecutorInstanceId) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM executor_registrations WHERE id=?")
      .get(id);
    return row ? v.parse(StoredRegistrationSchema, JSON.parse(row.data)) : null;
  }
  async read(id: ExecutorInstanceId) {
    return this.current(id);
  }
  private replace(reg: ExecutorRegistration, expected: ObjectVersion | null) {
    if ((this.current(reg.instanceId)?.version ?? null) !== expected) return false;
    this.store.db.run("INSERT OR REPLACE INTO executor_registrations VALUES(?,?)", [
      reg.instanceId,
      JSON.stringify(reg),
    ]);
    this.probes.delete(reg.instanceId);
    this.targets.delete(reg.instanceId);
    return true;
  }
  async save(reg: ExecutorRegistration, expected: ObjectVersion | null) {
    return this.replace(reg, expected);
  }
  configure(
    ctx: FirstSendContext,
    payload: Extract<SignedRequest, { method: "executor.configure" }>["payload"],
  ): CommandReceipt {
    return recordCommand(
      ctx,
      REQUEST_METHODS.configureExecutor,
      payload,
      { kind: "environment", environmentId: ctx.actor.environmentId },
      () => {
        const { registration: r, expectedVersion } = payload;
        const reject = (kind: "notFound" | "idConflict" | "unsupported") =>
          ({ kind: "rejected", commandId: ctx.commandId, failure: { kind } }) as const;
        if (r.family !== "codex" || r.driver.endpoint !== null) return reject("unsupported");
        const allowed = (b: CredentialBinding) =>
          b.ownerId === ctx.actor.id && this.secret(r.instanceId, b) !== null;
        if (
          (r.credential && !allowed(r.credential)) ||
          Object.values(r.driver.variables).some((x) => x.kind === "secret" && !allowed(x.binding))
        )
          return reject("notFound");
        const version = v.parse(ObjectVersionSchema, String(BigInt(expectedVersion ?? 0) + 1n));
        if (!this.replace({ ...r, version }, expectedVersion)) return reject("idConflict");
        return { kind: "executorConfigured", instanceId: r.instanceId, version };
      },
    );
  }
  defaultFor(project: string) {
    return this.store.db
      .query<{ instance: ExecutorInstanceId }, [string]>(
        "SELECT instance FROM project_executor_defaults WHERE project=?",
      )
      .get(project)?.instance;
  }
  setDefault(project: string, instance: ExecutorInstanceId) {
    this.store.db.run("INSERT OR IGNORE INTO project_executor_defaults VALUES(?,?)", [
      project,
      instance,
    ]);
  }
  begin(id: ExecutorInstanceId, cwd: string) {
    const target = { cwd, token: Symbol() };
    this.targets.set(id, target);
    return target;
  }
  isCurrent(id: ExecutorInstanceId, t: { cwd: string; token: symbol }) {
    return this.targets.get(id) === t;
  }
  async readProbe(id: ExecutorInstanceId) {
    return this.probes.get(id) ?? null;
  }
  async snapshot(id: ExecutorInstanceId) {
    const p = this.probes.get(id),
      r = this.current(id);
    if (!p || !r || p.configurationVersion !== r.version) return null;
    return v.parse(ExecutorInstanceSnapshotSchema, {
      family: r.family,
      instanceId: id,
      version: p.declaration.version,
      checkedAt: p.declaration.checkedAt,
      matrix: p.declaration.matrix,
      permission: r.permission,
    });
  }
  async publish(p: InstanceProbe) {
    const r = this.current(p.instanceId);
    if (
      !r ||
      r.family !== p.family ||
      r.version !== p.configurationVersion ||
      !Bun.deepEquals(r.credential, p.credential) ||
      !Bun.deepEquals(r.model, p.model) ||
      this.targets.get(p.instanceId)?.cwd !== p.workingDirectory
    )
      return null;
    this.probes.set(p.instanceId, p);
    return this.snapshot(p.instanceId);
  }
}
export function visibleRegistration(reg: ExecutorRegistration | null, actor: PrincipalId) {
  return reg &&
    (!reg.credential || reg.credential.ownerId === actor) &&
    Object.values(reg.driver.variables).every(
      (v) => v.kind === "literal" || v.binding.ownerId === actor,
    )
    ? reg
    : null;
}
