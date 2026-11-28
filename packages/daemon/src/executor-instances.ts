import * as v from "valibot";
import * as registered from "./executor-families/registry";
import type { ExecutorFamily, FamilyProbe } from "@kraka/environment";
import {
  readProject,
  recordCommand,
  visibleRegistration,
  WriterExecutorRegistry,
  type FirstSendContext,
  type FirstSendStore,
  type ExecutorRegistration,
  type SessionSetup,
} from "@kraka/environment";
import {
  REQUEST_METHODS,
  ChildModelSchema,
  ExecutorInstanceIdSchema,
  type Thread,
  type ThreadId,
  type CommandReceipt,
  type ExecutorInstanceId,
  type ExecutorInstanceSnapshot,
  type ExecutorRefreshed,
  type PrincipalId,
  type ProjectId,
  type SignedRequest,
} from "@kraka/protocol";
type Entry = {
  reg: ExecutorRegistration;
  cwd: string;
  probe: FamilyProbe;
  snapshot: ExecutorInstanceSnapshot;
};
export class ExecutorInstances {
  readonly registry;
  private entries = new Map<string, Entry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  readonly active = new Set<Promise<unknown>>();
  private readonly families;
  constructor(
    private store: FirstSendStore,
    families: readonly ExecutorFamily[] = Object.values(registered),
  ) {
    this.families = new Map(families.map((family) => [family.family, family]));
    this.registry = new WriterExecutorRegistry(store);
  }
  configure(
    ctx: FirstSendContext,
    payload: Extract<SignedRequest, { method: "executor.configure" }>["payload"],
  ) {
    return this.registry.configure(
      ctx,
      payload,
      (reg) => this.families.get(reg.family)?.supports(reg) ?? false,
    );
  }
  forThread(threadId: ThreadId) {
    return this.store.db
      .query<{ instance: string; version: string; model: string }, [string]>(
        "SELECT e.instance,e.version,e.model FROM round_executors e JOIN rounds r ON r.id=e.round WHERE json_extract(r.data,'$.threadId')=? ORDER BY r.rowid DESC LIMIT 1",
      )
      .get(threadId);
  }
  async resolve(
    saved: NonNullable<ReturnType<ExecutorInstances["forThread"]>>,
    actor: PrincipalId,
    thread: Thread,
  ) {
    const id = v.parse(ExecutorInstanceIdSchema, saved.instance);
    if (this.registry.current(id)?.version !== saved.version) return null;
    const entry = await this.lookup(
      id,
      actor,
      thread.projectId,
      thread.worktreeId ? () => this.store.directory(thread) : undefined,
    );
    if (entry?.reg.version !== saved.version) return null;
    return this.select(entry, v.parse(ChildModelSchema, JSON.parse(saved.model)));
  }
  async close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    await Promise.allSettled(this.active);
  }
  current(id: ExecutorInstanceId, owner: PrincipalId, cwd: string) {
    const entry = this.entries.get(id),
      reg = visibleRegistration(this.registry.current(id), owner);
    return entry &&
      entry.cwd === cwd &&
      reg?.version === entry.reg.version &&
      entry.probe.retryAt > Date.now()
      ? entry
      : null;
  }
  async lookup(
    id: ExecutorInstanceId,
    actor: PrincipalId,
    projectId: ProjectId,
    directory = () => this.store.projectDirectory(projectId),
  ) {
    const cwd = directory(),
      reg = visibleRegistration(this.registry.current(id), actor);
    if (!cwd || !reg) return null;
    const cached = this.current(id, actor, cwd);
    if (cached) return cached;
    const work = this.probe(reg, directory, cwd, actor);
    this.active.add(work);
    try {
      return await work;
    } finally {
      this.active.delete(work);
    }
  }
  select(entry: Entry | null, selection: SessionSetup["model"] | undefined) {
    if (
      !entry ||
      !entry.probe.declaration.permission.modes.includes(entry.snapshot.permission.selected) ||
      Object.values(entry.probe.declaration.readiness).some(
        (l) => l.state !== "yes" || l.verifiedAt === null,
      )
    )
      return null;
    const model = entry.probe.selectModel(selection ?? entry.reg.model);
    return model ? { ...entry, model } : null;
  }
  async probe(
    reg: ExecutorRegistration,
    directory: () => string | null,
    cwd: string,
    actor: PrincipalId,
  ) {
    const token = this.registry.begin(reg.instanceId, cwd);
    const prev = this.entries.get(reg.instanceId);
    const family = this.families.get(reg.family);
    if (!family || !family.supports(reg)) return null;
    const probe =
      prev?.reg.version === reg.version && prev.cwd === cwd
        ? await prev.probe.refresh()
        : await family.probe(reg, cwd, this.registry.environment(reg));
    if (probe.declaration.family !== reg.family) throw Error("Mismatched probe family");
    if (this.closed || !this.registry.isCurrent(reg.instanceId, token) || directory() !== cwd)
      return null;
    const snapshot = await this.registry.publish({
      family: reg.family,
      instanceId: reg.instanceId,
      configurationVersion: reg.version,
      credential: reg.credential,
      workingDirectory: cwd,
      model: reg.model,
      binaryVersion: probe.binaryVersion,
      declaration: probe.declaration,
    });
    if (!snapshot || !this.registry.isCurrent(reg.instanceId, token)) return null;
    const entry = {
      reg,
      cwd,
      probe,
      snapshot,
    };
    this.entries.set(reg.instanceId, entry);
    clearTimeout(this.timers.get(reg.instanceId));
    const timer = setTimeout(
      () => {
        if (
          this.closed ||
          directory() !== cwd ||
          !visibleRegistration(this.registry.current(reg.instanceId), actor) ||
          reg.version !== this.registry.current(reg.instanceId)?.version
        )
          return;
        const work = this.probe(reg, directory, cwd, actor);
        this.active.add(work);
        void work.catch(() => {}).finally(() => this.active.delete(work));
      },
      Math.max(0, probe.retryAt - Date.now()),
    );
    timer.unref();
    this.timers.set(reg.instanceId, timer);
    return entry;
  }
  async refresh(
    ctx: FirstSendContext,
    payload: Extract<SignedRequest, { method: "executor.refresh" }>["payload"],
  ) {
    const { projectId, instanceId } = payload,
      { actor, commandId } = ctx;
    const target = { kind: "project", projectId } as const;
    const operation = REQUEST_METHODS.refreshExecutor;
    if (!actor.allows(operation.permission, target))
      return {
        kind: "rejected",
        commandId,
        failure: { kind: "missingPermission", permission: operation.permission, target },
      } as const;
    const reg = visibleRegistration(this.registry.current(instanceId), actor.id),
      project = readProject(this.store.db, projectId);
    const cwd = this.store.projectDirectory(projectId);
    let entry =
      reg && cwd && project?.environmentId === actor.environmentId
        ? this.current(instanceId, actor.id, cwd)
        : null;
    if (!entry && reg && cwd && project?.environmentId === actor.environmentId)
      entry = await this.probe(reg, () => this.store.projectDirectory(projectId), cwd, actor.id);
    return recordCommand(
      ctx,
      operation,
      payload,
      target,
      (): ExecutorRefreshed | CommandReceipt => {
        if (!entry || entry.reg.version !== this.registry.current(instanceId)?.version)
          return {
            kind: "rejected",
            commandId,
            failure: { kind: reg ? "invalidState" : "notFound" },
          };
        const { probe, snapshot } = entry;
        const registration = entry.reg;
        if (registration.enabled) this.registry.setDefault(projectId, instanceId);
        return {
          kind: "executorRefreshed",
          displayName: registration.displayName,
          enabled: registration.enabled,
          configurationVersion: registration.version,
          instanceId,
          snapshot,
          readiness: { ...probe.declaration.readiness },
          models: probe.models,
          binaryVersion: probe.binaryVersion,
          variables: Object.entries(registration.driver.variables).map(([name, v]) => ({
            name,
            kind: v.kind,
          })),
          compatibilityAdvisory: probe.compatibilityAdvisory,
          versionAdvisory: probe.versionAdvisory,
        };
      },
    );
  }
}
export type ExecutorSelection = NonNullable<ReturnType<ExecutorInstances["select"]>>;
