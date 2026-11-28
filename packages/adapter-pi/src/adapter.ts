import type {
  ActionPermit,
  AdapterCapability,
  AdapterCallResult,
  AdapterCommand,
  AdapterInstance,
  AdapterSession,
  InstanceServiceCommand,
  InstanceServiceResult,
  InvocationResult,
  ProviderAdapter,
  SessionInvocationResult,
  AdapterRejectedReason,
} from "@kraka/environment";
import { checkPiAccount, type PiProbe } from "./discovery";
import { openPiProcess, type PiLaunch } from "./launch";
import { PiError } from "./native";
import { PiSessionHandle } from "./session";
type Instance = AdapterInstance<"pi">;
type Session = AdapterSession<"pi", PiSessionHandle>;
const ok = <T>(value: T) => ({ kind: "ok", value }) as const;
const reject = (reason: AdapterRejectedReason, message: string | null = null) =>
  ({ kind: "rejected", reason, message }) as const;
export function createPiAdapter(
  instance: Instance,
  launch: PiLaunch,
  probe: PiProbe,
  previousEpoch = 0,
): ProviderAdapter<"pi", PiSessionHandle> {
  let epoch = previousEpoch;
  const handles = new WeakSet<PiSessionHandle>();
  const matches = (i: Instance) =>
    i.family === instance.family && i.instanceId === instance.instanceId;
  const owns = (s: Session) =>
    matches(s) &&
    handles.has(s.handle) &&
    s.epoch === s.handle.epoch &&
    s.nativeSessionId === s.handle.nativeSessionId;
  async function invoke<C extends InstanceServiceCommand>(
    i: Instance,
    p: ActionPermit<"pi", NoInfer<C["capability"]>>,
    cmd: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  async function invoke<C extends AdapterCommand>(
    s: Session,
    p: ActionPermit<"pi", NoInfer<C["capability"]>>,
    cmd: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    target: Instance | Session,
    permit: ActionPermit<"pi", AdapterCapability>,
    cmd: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>> {
    if (
      !matches(target) ||
      !matches(permit) ||
      permit.capabilityVersion !== probe.declaration.version ||
      permit.capability !== cmd.capability
    )
      return reject("invalidCapabilitySnapshot");
    if (
      cmd.capability === "generateText" ||
      probe.declaration.matrix[cmd.capability].kind === "unsupported" ||
      !Bun.deepEquals(permit.support, probe.declaration.matrix[cmd.capability])
    )
      return reject("unsupported");
    if (!("handle" in target)) {
      if (cmd.capability === "listModels" && probe.models)
        return ok({ kind: "service", result: probe.models });
      if (cmd.capability === "checkAuthentication")
        return ok({
          kind: "service",
          result: { status: probe.declaration.readiness.authenticated, account: null },
        });
      return reject("unsupported");
    }
    if (!owns(target))
      return reject(cmd.kind === "deliverAnswer" ? "requestExpired" : "invalidState");
    try {
      switch (cmd.kind) {
        case "deliverInput":
          return ok(await target.handle.deliver(cmd));
        case "deliverAnswer":
          return ok(await target.handle.answer(cmd));
        case "stop":
          return ok(await target.handle.stop(cmd));
        default:
          return reject("unsupported");
      }
    } catch (error) {
      return error instanceof PiError
        ? reject(error.reason, error.message)
        : reject("unsafeToRetry", "Pi operation could not be verified");
    }
  }
  return {
    async capabilities(i) {
      return matches(i) ? ok(probe.declaration) : reject("wrongFamily");
    },
    async open({ instance: i, attemptId, resume, setup }) {
      if (!matches(i)) return reject("wrongFamily");
      if (
        setup.additionalDirectories.length ||
        setup.workingDirectory !== launch.cwd ||
        Object.keys(setup.model.options).length ||
        !probe.models?.models.some((m) => m.id === setup.model.id) ||
        Object.values(probe.declaration.readiness).some((l) => l.state !== "yes") ||
        !probe.declaration.permission.modes.includes(setup.permission.selected) ||
        Object.keys(setup.environment).length > 0
      )
        return reject("unsupported");
      try {
        if ((await checkPiAccount(launch, setup.model.id)).state !== "yes")
          return reject("notAuthenticated");
        const process = await openPiProcess(launch, ++epoch, setup.permission.selected, {
          kind: "session",
          resume,
          model: setup.model.id,
        });
        const handle = new PiSessionHandle(process, instance, attemptId);
        handles.add(handle);
        return ok({
          ...instance,
          nativeSessionId: handle.nativeSessionId,
          epoch: handle.epoch,
          handle,
        });
      } catch (error) {
        return error instanceof PiError
          ? reject(error.reason, error.message)
          : reject("invalidState", "Pi session could not be verified");
      }
    },
    invoke,
    async *events(session, after) {
      if (!owns(session)) throw Error("Foreign Pi handle");
      yield* session.handle.events(after);
    },
    async close(session) {
      if (!owns(session)) return reject("invalidState");
      await session.handle.close();
      return ok(undefined);
    },
  };
}
export type PiAdapterFactory = typeof createPiAdapter;
