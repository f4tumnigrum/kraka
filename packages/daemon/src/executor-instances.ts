import * as v from "valibot";
import { LoginController, systemLoginClock, type LoginClock } from "./instance-login";
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
  InstancePermissionSchema,
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
export type InstanceEntry = {
  reg: ExecutorRegistration;
  cwd: string;
  probe: FamilyProbe;
  snapshot: ExecutorInstanceSnapshot;
};
export class ExecutorInstances {
  readonly registry;
  private entries = new Map<string, InstanceEntry>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private closed = false;
  readonly active = new Set<Promise<unknown>>();
  private readonly families;
  readonly login: LoginController;
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(
    private store: FirstSendStore,
    families: readonly ExecutorFamily[] = Object.values(registered),
    readonly clock: LoginClock = systemLoginClock,
  ) {
    this.families = new Map(families.map((family) => [family.family, family]));
    this.registry = new WriterExecutorRegistry(store);
    this.login = new LoginController(store, this, clock);
    this.login.recover();
  }
  configure(
    ctx: FirstSendContext,
    payload: Extract<SignedRequest, { method: "executor.configure" }>["payload"],
  ) {
    const receipt = this.registry.configure(
      ctx,
      payload,
      (reg) => this.families.get(reg.family)?.supports(reg) ?? false,
    );
    if (receipt.kind === "accepted")
      this.login.registrationChanged(payload.registration.instanceId);
    return receipt;
  }
  forThread(threadId: ThreadId) {
    return this.store.db
      .query<{ instance: string; version: string; model: string }, [string]>(
        "SELECT instance,version,model FROM round_executors WHERE round=(SELECT id FROM rounds WHERE json_extract(data,'$.threadId')=? ORDER BY rowid LIMIT 1)",
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
    const choice = this.select(entry, v.parse(ChildModelSchema, JSON.parse(saved.model)));
    const child = this.store.db
      .query<{ mode: "ask" | "edits" | "open" }, [string]>(
        "SELECT json_extract(data,'$.effectiveMode') AS mode FROM delegated_children WHERE json_extract(data,'$.childThreadId')=? LIMIT 1",
      )
      .get(thread.id);
    if (!choice || !child) return choice;
    return {
      ...choice,
      sessionPermission: v.parse(InstancePermissionSchema, {
        ceiling: child.mode,
        selected: child.mode,
      }),
    };
  }
  async close() {
    this.closed = true;
    this.login.close();
    for (const timer of this.timers.values()) clearTimeout(timer);
    while (this.active.size) await Promise.allSettled([...this.active]);
  }
  current(id: ExecutorInstanceId, owner: PrincipalId, cwd: string) {
    const entry = this.entries.get(id),
      reg = visibleRegistration(this.registry.current(id), owner);
    return entry &&
      entry.cwd === cwd &&
      reg?.version === entry.reg.version &&
      entry.probe.retryAt > this.clock.now()
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
  select(entry: InstanceEntry | null, selection: SessionSetup["model"] | undefined) {
    if (
      !entry ||
      !entry.probe.declaration.permission.modes.includes(entry.snapshot.permission.selected) ||
      Object.values(entry.probe.declaration.readiness).some(
        (l) => l.state !== "yes" || l.verifiedAt === null,
      )
    )
      return null;
    const model = entry.probe.selectModel(selection ?? entry.reg.model);
    return model ? { ...entry, model, sessionPermission: entry.snapshot.permission } : null;
  }
  track<T>(work: Promise<T>) {
    this.active.add(work);
    const done = () => this.active.delete(work);
    void work.then(done, done);
    return work;
  }
  serialize<T>(reg: ExecutorRegistration, run: () => Promise<T>) {
    const key = JSON.stringify([
      reg.family,
      reg.driver.configurationRoot ?? [reg.instanceId, reg.credential],
    ]);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const work = prior.catch(() => {}).then(run);
    this.queues.set(key, work);
    const clear = () => {
      if (this.queues.get(key) === work) this.queues.delete(key);
    };
    void work.then(clear, clear);
    return this.track(work);
  }
  supports(
    reg: ExecutorRegistration,
    capability: "startLogin" | "checkAuthentication" | "listModels",
  ) {
    const entry = this.entries.get(reg.instanceId);
    return (
      entry?.reg.version === reg.version && entry.snapshot.matrix[capability].kind !== "unsupported"
    );
  }
  async failedAuthentication(
    reg: ExecutorRegistration,
    status: import("@kraka/environment").Readiness,
    reason: string,
  ) {
    const entry = this.entries.get(reg.instanceId);
    if (
      !entry ||
      entry.reg.version !== reg.version ||
      this.registry.current(reg.instanceId)?.version !== reg.version
    )
      return;
    const checkedAt = this.clock.now();
    const unknown = { state: "unknown", verifiedAt: null } as const;
    const declaration = {
      ...entry.probe.declaration,
      checkedAt,
      readiness: {
        ...entry.probe.declaration.readiness,
        authenticated: status,
        model: unknown,
        operation: unknown,
      },
    };
    const probe = {
      ...entry.probe,
      declaration,
      models: null,
      attemptedAt: checkedAt,
      authenticationReason: reason,
    };
    const snapshot = await this.registry.publish({
      family: reg.family,
      instanceId: reg.instanceId,
      configurationVersion: reg.version,
      credential: reg.credential,
      model: reg.model,
      workingDirectory: entry.cwd,
      binaryVersion: probe.binaryVersion,
      declaration,
    });
    if (snapshot && this.entries.get(reg.instanceId) === entry)
      this.entries.set(reg.instanceId, { ...entry, probe, snapshot });
  }
  profileDirectory(reg: ExecutorRegistration) {
    return (
      this.entries.get(reg.instanceId)?.cwd ??
      reg.driver.configurationRoot ??
      this.store.writer.stateDirectory
    );
  }
  probe(
    reg: ExecutorRegistration,
    directory: () => string | null,
    cwd: string,
    actor: PrincipalId | undefined,
    authorize = () => true,
  ) {
    return this.serialize(reg, () => this.discover(reg, directory, cwd, actor, authorize));
  }
  async discover(
    reg: ExecutorRegistration,
    directory: () => string | null,
    cwd: string,
    actor: PrincipalId | undefined,
    authorize = () => true,
    expectedAccount?: string,
    verifiedCatalog?: ExecutorRefreshed["models"],
  ) {
    const valid = () =>
      !this.closed &&
      authorize() &&
      this.registry.current(reg.instanceId)?.version === reg.version &&
      directory() === cwd;
    if (!valid()) return null;
    const scope = {
      now: this.clock.now,
      authorize: valid,
      ...(expectedAccount !== undefined && { expectedAccount }),
      ...(verifiedCatalog !== undefined && { verifiedCatalog }),
    };
    const token = this.registry.begin(reg.instanceId, cwd);
    const prev = this.entries.get(reg.instanceId);
    const family = this.families.get(reg.family);
    if (!family || !family.supports(reg)) return null;
    const probe =
      prev?.reg.version === reg.version && prev.cwd === cwd
        ? await prev.probe.refresh(scope)
        : await family.probe(reg, cwd, this.registry.environment(reg), scope);
    if (probe.declaration.family !== reg.family) throw Error("Mismatched probe family");
    if (!valid() || !this.registry.isCurrent(reg.instanceId, token)) return null;
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
          (actor !== undefined &&
            !visibleRegistration(this.registry.current(reg.instanceId), actor)) ||
          reg.version !== this.registry.current(reg.instanceId)?.version
        )
          return;
        const work = this.probe(reg, directory, cwd, actor);
        this.active.add(work);
        void work.catch(() => {}).finally(() => this.active.delete(work));
      },
      Math.max(0, probe.retryAt - this.clock.now()),
    );
    timer.unref();
    this.timers.set(reg.instanceId, timer);
    return entry;
  }
  async refresh(
    ctx: FirstSendContext,
    payload: Extract<SignedRequest, { method: "executor.refresh" }>["payload"],
    owner = ctx.actor.id,
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
    const reg =
        visibleRegistration(this.registry.current(instanceId), actor.id) ??
        visibleRegistration(this.registry.current(instanceId), owner),
      project = readProject(this.store.db, projectId);
    const cwd = this.store.projectDirectory(projectId);
    let entry =
      reg && cwd && project?.environmentId === actor.environmentId
        ? this.current(instanceId, owner, cwd)
        : null;
    if ((!entry || payload.force) && reg && cwd && project?.environmentId === actor.environmentId)
      entry = await this.probe(
        reg,
        () => this.store.projectDirectory(projectId),
        cwd,
        owner,
        () => actor.allows(operation.permission, target),
      );
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
          authenticationReason: probe.authenticationReason ?? null,
          attemptedAt: probe.attemptedAt ?? probe.declaration.checkedAt,
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
