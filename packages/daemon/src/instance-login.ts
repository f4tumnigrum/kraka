import * as v from "valibot";
import {
  checkCommand,
  recordCommand,
  visibleRegistration,
  type FirstSendContext,
  type FirstSendStore,
  type LoginFlow,
  type ExecutorDriver,
  type ExecutorRegistration,
} from "@kraka/environment";
import {
  DeliveryIdSchema,
  ModelCatalogSchema,
  REQUEST_METHODS,
  type CommandId,
  type CommandReceipt,
  type EnvironmentSessionId,
  type ExecutorInstanceId,
  type PrincipalId,
  type SignedRequest,
} from "@kraka/protocol";
import type { ExecutorInstances, InstanceEntry } from "./executor-instances";

export interface LoginClock {
  now(): number;
  at(deadline: number, run: () => Promise<void>): () => void;
  handled?(flowId: CommandId, disposition: "applied" | "discarded"): void;
}
export const systemLoginClock: LoginClock = {
  now: Date.now,
  at(deadline, run) {
    const timer = setTimeout(
      () => void run().catch(() => {}),
      Math.min(2147483647, Math.max(0, deadline - Date.now())),
    );
    timer.unref();
    return () => clearTimeout(timer);
  },
};
export type LoginRequest = Extract<
  SignedRequest,
  { method: "executor.startLogin" | "executor.readLogin" | "executor.cancelLogin" }
>;
export type LoginSession = {
  id: EnvironmentSessionId;
  owner: PrincipalId;
  active: () => boolean;
  signal: AbortSignal;
};
type Running = {
  flow: LoginFlow;
  session: LoginSession;
  allowed: () => boolean;
  stop: AbortController;
  unschedule: () => void;
  detach: () => void;
  entry?: InstanceEntry;
  driver?: ExecutorDriver;
  nativeId?: string;
};
const rejected = (
  commandId: CommandId,
  kind: "notFound" | "idConflict" | "invalidState" | "unsupported",
): CommandReceipt => ({ kind: "rejected", commandId, failure: { kind } });
const method = {
  "executor.startLogin": REQUEST_METHODS.startLogin,
  "executor.cancelLogin": REQUEST_METHODS.cancelLogin,
  "executor.readLogin": REQUEST_METHODS.readLogin,
};
export class LoginController {
  private readonly running = new Map<CommandId, Running>();
  private closed = false;
  private readonly ledger;
  constructor(
    store: FirstSendStore,
    private instances: ExecutorInstances,
    private clock: LoginClock,
  ) {
    this.ledger = store.services.logins;
  }
  recover() {
    for (const flow of this.ledger.pendingAccountChecks()) this.background(this.reconcile(flow));
  }
  private background(work: Promise<unknown>) {
    void this.instances.track(work).catch(() => {});
  }
  private async reconcile(flow: LoginFlow) {
    if (this.closed) return;
    const reg = this.instances.registry.current(flow.instanceId);
    if (!reg?.enabled) return;
    const cwd = this.instances.profileDirectory(reg);
    const owner =
      reg.credential?.ownerId ??
      Object.values(reg.driver.variables).find((v) => v.kind === "secret")?.binding.ownerId;
    const entry = await this.instances.probe(reg, () => cwd, cwd, owner);
    if (entry) this.ledger.accountChecked(flow.flowId);
  }
  private advance(flow: LoginFlow, event: Parameters<typeof this.ledger.advanceLogin>[0]["event"]) {
    return this.ledger.advanceLogin({
      ...flow,
      expectedCredential: flow.credential,
      now: this.clock.now(),
      event,
    });
  }
  private finish(r: Running) {
    r.unschedule();
    r.detach();
    r.stop.abort();
    this.running.delete(r.flow.flowId);
  }
  private linger(r: Running) {
    r.unschedule();
    r.unschedule = this.clock.at(this.clock.now() + 30000, async () => this.finish(r));
  }
  private expire(r: Running) {
    r.unschedule();
    r.unschedule = this.clock.at(r.flow.expiresAt, async () => {
      const changed = this.advance(r.flow, { kind: "check" });
      if (changed?.record.phase !== "expired") {
        if (this.clock.now() < r.flow.expiresAt) this.expire(r);
        return;
      }
      this.linger(r);
      await this.reconcile(r.flow);
    });
  }
  registrationChanged(id: ExecutorInstanceId) {
    for (const r of this.running.values()) {
      if (
        r.flow.instanceId !== id ||
        this.instances.registry.current(id)?.version === r.flow.configVersion
      )
        continue;
      this.advance(r.flow, { kind: "check" });
      this.finish(r);
      this.background(this.reconcile(r.flow));
    }
  }
  close() {
    this.closed = true;
    for (const r of this.running.values()) this.finish(r);
  }
  private current(
    r: Running,
    capability: "startLogin" | "checkAuthentication" | "listModels",
    phase?: string,
  ) {
    const current = this.instances.registry.current(r.flow.instanceId);
    const record = this.ledger.load(r.flow.flowId);
    return (
      !this.closed &&
      !r.stop.signal.aborted &&
      r.allowed() &&
      current?.enabled === true &&
      current.version === r.flow.configVersion &&
      Bun.deepEquals(current.credential, r.flow.credential) &&
      record?.ownerSessionId === r.flow.ownerSessionId &&
      (!phase || (record.phase === phase && this.clock.now() < record.expiresAt)) &&
      (r.entry === undefined || this.instances.supports(r.entry.reg, capability))
    );
  }
  private async complete(r: Running, nativeLoginId: string, success: boolean) {
    const { flow, entry, driver } = r;
    const valid = this.current(r, "checkAuthentication");
    const transition = this.advance(
      flow,
      valid
        ? { kind: "callback", nativeLoginId, success }
        : { kind: "failed", reason: "Session authorization ended" },
    );
    const applied = valid && transition?.applied === true;
    if (!applied || transition?.record.phase !== "verifying" || !entry || !driver) {
      this.clock.handled?.(flow.flowId, applied ? "applied" : "discarded");
      if (
        transition?.record.needsAccountCheck ||
        transition?.record.phase === "cancelled" ||
        transition?.record.phase === "expired"
      ) {
        await this.reconcile(flow);
        this.finish(r);
      }
      return;
    }
    const authorize = () => this.current(r, "checkAuthentication", "verifying");
    await this.instances.serialize(entry.reg, async () => {
      const support = entry.snapshot.matrix.checkAuthentication;
      if (!authorize() || support.kind === "unsupported") return;
      const response = await driver.invokeInstance(
        { capabilityVersion: entry.snapshot.version, support },
        {
          kind: "service",
          capability: "checkAuthentication",
          deliveryId: v.parse(DeliveryIdSchema, flow.flowId),
          request: { kind: "checkAuthentication", authorize },
        },
      );
      if (!authorize()) return;
      let authentication =
        response.kind === "ok"
          ? response.value.result
          : { account: null, status: { state: "unknown" as const, verifiedAt: this.clock.now() } };
      if (
        authentication.status.state === "yes" &&
        authentication.account === flow.expectedAccount
      ) {
        // Rebuild ordinary turn readiness and the catalog under the same profile lock.
        const modelSupport = entry.snapshot.matrix.listModels;
        const canList = () => authorize() && this.current(r, "listModels", "verifying");
        const catalog =
          canList() && modelSupport.kind !== "unsupported"
            ? await driver.invokeInstance(
                { capabilityVersion: entry.snapshot.version, support: modelSupport },
                {
                  kind: "service",
                  capability: "listModels",
                  deliveryId: v.parse(DeliveryIdSchema, flow.flowId),
                  request: {
                    kind: "listModels",
                    verifiedAccount: {
                      expectedAccount: flow.expectedAccount,
                      authorize: canList,
                      authenticationPermit: {
                        family: entry.reg.family,
                        instanceId: flow.instanceId,
                        capability: "checkAuthentication",
                        capabilityVersion: entry.snapshot.version,
                        support,
                      },
                    },
                  },
                },
              )
            : null;
        if (!authorize()) return;
        const verifiedCatalog =
          catalog?.kind === "ok" ? v.parse(ModelCatalogSchema, catalog.value.result) : null;
        const refreshed = await this.instances.discover(
          entry.reg,
          () => entry.cwd,
          entry.cwd,
          r.session.owner,
          authorize,
          flow.expectedAccount,
          verifiedCatalog,
        );
        if (!authorize()) return;
        if (refreshed?.probe.declaration.readiness.authenticated.state !== "yes")
          authentication = {
            account: null,
            status: refreshed?.probe.declaration.readiness.authenticated ?? {
              state: "unknown",
              verifiedAt: null,
            },
          };
      }
      const settled = this.advance(flow, { kind: "probe", authentication });
      if (settled?.applied && settled.record.phase === "failed") {
        const status =
          authentication.status.state === "yes"
            ? { ...authentication.status, state: "no" as const }
            : authentication.status;
        await this.instances.failedAuthentication(
          entry.reg,
          status,
          settled.record.reason ?? "Account probe inconclusive",
        );
      }
    });
    this.clock.handled?.(flow.flowId, applied ? "applied" : "discarded");
    if (!authorize() && this.ledger.load(flow.flowId)?.phase === "verifying")
      this.advance(flow, { kind: "failed", reason: "Session authorization ended" });
    if (this.ledger.load(flow.flowId)?.phase !== "verifying") this.finish(r);
  }
  private async start(r: Running, reg: ExecutorRegistration) {
    const cwd = this.instances.profileDirectory(reg);
    const starting = () => this.current(r, "startLogin", "starting");
    const entry =
      this.instances.current(reg.instanceId, r.session.owner, cwd) ??
      (await this.instances.probe(reg, () => cwd, cwd, r.session.owner, starting));
    if (!entry || !starting()) throw Error("Instance unavailable");
    const support = entry.snapshot.matrix.startLogin;
    if (support.kind === "unsupported") throw Error("Login unsupported");
    r.entry = entry;
    const driver = entry.probe.driver(0);
    r.driver = driver;
    const opened = Promise.withResolvers<void>();
    try {
      const response = await this.instances.serialize(reg, () =>
        driver.invokeInstance(
          { capabilityVersion: entry.snapshot.version, support },
          {
            kind: "service",
            capability: "startLogin",
            deliveryId: v.parse(DeliveryIdSchema, r.flow.flowId),
            request: {
              kind: "login",
              flow: r.flow,
              observer: {
                signal: r.stop.signal,
                authorize: (action) =>
                  action === "cancel" ? this.current(r, "startLogin") : starting(),
                completed: (native, success) =>
                  this.background(opened.promise.then(() => this.complete(r, native, success))),
                track: (p) => this.background(p),
                disconnected: () =>
                  this.background(
                    opened.promise.then(async () => {
                      if (!r.stop.signal.aborted) {
                        this.advance(r.flow, { kind: "failed", reason: "Login connection closed" });
                        this.finish(r);
                        await this.reconcile(r.flow);
                      }
                    }),
                  ),
              },
            },
          },
        ),
      );
      if (response.kind !== "ok") throw Error("Login unavailable");
      const result = response.value.result;
      if (
        result.flowId !== r.flow.flowId ||
        result.instanceId !== reg.instanceId ||
        result.ownerSessionId !== r.session.id ||
        result.configVersion !== reg.version ||
        !Bun.deepEquals(result.credential, r.flow.credential) ||
        !(
          result.status.kind === "browser" ||
          result.status.kind === "nativeCli" ||
          result.status.kind === "deviceCode"
        )
      )
        throw Error("Unexpected login");
      r.nativeId = result.nativeLoginId;
      if (!starting()) throw Error("Login invalidated");
      const change = this.advance(r.flow, {
        kind: "started",
        interaction: result.status,
        nativeLoginId: result.nativeLoginId,
        expiresAt: result.expiresAt,
      });
      r.flow = { ...r.flow, expiresAt: result.expiresAt };
      if (change?.record.phase === "expired") {
        this.linger(r);
        await this.reconcile(r.flow);
      } else this.expire(r);
    } finally {
      opened.resolve();
    }
  }
  async command(
    ctx: FirstSendContext,
    session: LoginSession,
    req: LoginRequest,
  ): Promise<CommandReceipt> {
    const { instanceId } = req.payload,
      { commandId } = req;
    const target = { kind: "environment", environmentId: ctx.actor.environmentId } as const;
    const operation = method[req.method];
    const allowed = () =>
      session.active() && !session.signal.aborted && ctx.actor.allows(operation.permission, target);
    const prior = checkCommand(ctx, operation, req.payload, target).receipt;
    if (prior?.kind === "rejected") return prior;
    const registration = this.instances.registry.current(instanceId);
    const reg =
      visibleRegistration(registration, ctx.actor.id) ??
      visibleRegistration(registration, session.owner);
    if (!allowed() || !reg) return rejected(commandId, "notFound");
    const flowId = "flowId" in req.payload ? req.payload.flowId : commandId;
    const view = () => this.ledger.read(flowId, instanceId, session.id, this.clock.now());
    const run = this.running.get(flowId);
    if (req.method === "executor.startLogin") {
      const begun = this.ledger.begin(
        {
          ...req.payload,
          flowId,
          ownerSessionId: session.id,
          configVersion: reg.version,
          credential: reg.credential,
        },
        this.clock.now(),
      );
      if (begun.kind === "conflict") return rejected(commandId, "idConflict");
      if (begun.kind === "created") {
        const flow = begun.flow;
        const r: Running = {
          flow,
          session,
          allowed,
          stop: new AbortController(),
          unschedule: () => {},
          detach: () => {},
        };
        this.running.set(flowId, r);
        const lost = () => {
          this.advance(flow, { kind: "failed", reason: "Session authorization ended" });
          this.finish(r);
          this.background(this.reconcile(flow));
        };
        session.signal.addEventListener("abort", lost, { once: true });
        r.detach = () => session.signal.removeEventListener("abort", lost);
        this.expire(r);
        const initial = view();
        if (initial) recordCommand(ctx, operation, req.payload, target, () => initial);
        try {
          await this.start(r, reg);
        } catch {
          this.advance(flow, { kind: "failed", reason: "Login unavailable" });
          this.finish(r);
          this.background(this.reconcile(flow));
        }
      }
    } else if (req.method === "executor.cancelLogin") {
      const flow = this.ledger.load(flowId);
      if (!flow || flow.instanceId !== instanceId || flow.ownerSessionId !== session.id)
        return rejected(commandId, "notFound");
      const change = this.advance(flow, { kind: "cancel" });
      if (change?.applied && change.record.phase === "cancelled" && run) {
        this.linger(run);
        const support = run.entry?.snapshot.matrix.startLogin;
        if (
          run.driver &&
          run.nativeId &&
          run.entry &&
          support &&
          support.kind !== "unsupported" &&
          this.current(run, "startLogin")
        ) {
          await run.driver.invokeInstance(
            { capabilityVersion: run.entry.snapshot.version, support },
            {
              kind: "service",
              capability: "startLogin",
              deliveryId: v.parse(DeliveryIdSchema, commandId),
              request: { kind: "cancelLogin", flow, nativeLoginId: run.nativeId },
            },
          );
        }
        this.background(this.reconcile(flow));
      }
    }
    const result = view();
    if (!allowed() || !result) return rejected(commandId, "notFound");
    const receipt = recordCommand(ctx, operation, req.payload, target, () => ({
      ...result,
      interaction: null,
    }));
    return receipt.kind === "accepted" ? { kind: "accepted", commandId, result } : receipt;
  }
}
