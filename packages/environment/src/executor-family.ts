import type {
  AdapterFamily,
  AttemptId,
  ExecutorInstanceId,
  ExecutorRefreshed,
  ExecutorTurnUpdate,
  NativeRequestId,
  NativeSessionId,
  RoundId,
} from "@kraka/protocol";
import type {
  ActionPermit,
  AdapterCallResult,
  AdapterCommand,
  AdapterEventEnvelope,
  AdapterEventPayload,
  AdapterSessionBinding,
  CapabilityDeclaration,
  CloseReason,
  InstanceServiceCommand,
  InstanceServiceResult,
  ProviderAdapter,
  SessionInvocationResult,
  SessionSetup,
} from "./adapter-contract";
import type { ExecutorRegistration } from "./executor-records";
import type { Round } from "@kraka/protocol";
import type { TodoLedger } from "./todo-ledger";
import { bindTodoSession } from "./todo-session";

type Model = SessionSetup["model"];
type Target = { roundId: RoundId; attemptId: AttemptId };
type Permit<C extends AdapterCommand> = Pick<
  ActionPermit<AdapterFamily, C["capability"]>,
  "capabilityVersion" | "support" | "stillAllowed"
>;
type SessionView = {
  requestOpen?(id: NativeRequestId): boolean;
  update?(payload: AdapterEventPayload, target: Target): ExecutorTurnUpdate | null;
  interrupted?(): { reason: string; message: string };
};

export interface ExecutorSession extends AdapterSessionBinding {
  attemptId: AttemptId;
  events(): AsyncIterable<AdapterEventEnvelope>;
  invoke<C extends AdapterCommand>(
    permit: Permit<C>,
    command: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  close(reason: CloseReason): Promise<AdapterCallResult<void>>;
  todos(
    ledger: TodoLedger,
    round: Round,
    declaration: CapabilityDeclaration,
  ): ReturnType<typeof bindTodoSession>;
  view: SessionView;
}
export interface ExecutorDriver {
  open(
    resume: NativeSessionId | null,
    attemptId: AttemptId,
    setup: SessionSetup,
  ): Promise<AdapterCallResult<ExecutorSession>>;
  invokeInstance<C extends InstanceServiceCommand>(
    permit: Permit<C>,
    command: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
}

/** Bind the family and its private handle once. Callers cannot mix handles from different drivers. */
export function bindExecutorAdapter<F extends AdapterFamily, H extends object>(
  instance: { family: F; instanceId: ExecutorInstanceId },
  adapter: ProviderAdapter<F, H>,
  view?: (handle: H, setup: SessionSetup) => SessionView,
): ExecutorDriver {
  return {
    invokeInstance: (permit, command) =>
      adapter.invoke(instance, { ...instance, ...permit, capability: command.capability }, command),
    async open(resume, attemptId, setup) {
      const opened = await adapter.open({ instance, resume, attemptId, setup });
      if (opened.kind === "rejected") return opened;
      const session = opened.value;
      if (session.family !== instance.family || session.instanceId !== instance.instanceId) {
        await adapter.close(session, "shutdown");
        return {
          kind: "rejected",
          reason: "invalidState",
          message: "Executor returned a foreign session",
        };
      }
      const info = view?.(session.handle, setup) ?? {};
      return {
        kind: "ok",
        value: {
          ...instance,
          epoch: session.epoch,
          nativeSessionId: session.nativeSessionId,
          attemptId,
          view: info,
          invoke: (permit, command) =>
            adapter.invoke(
              session,
              { ...instance, ...permit, capability: command.capability },
              command,
            ),
          events: () => adapter.events(session, null),
          close: (reason) => adapter.close(session, reason),
          todos: (ledger, round, declaration) =>
            bindTodoSession(
              ledger,
              round,
              session,
              adapter,
              { ...declaration, family: instance.family },
              info.requestOpen,
            ),
        },
      };
    },
  };
}
export interface FamilyProbe
  extends Pick<
    ExecutorRefreshed,
    "binaryVersion" | "models" | "compatibilityAdvisory" | "versionAdvisory"
  > {
  declaration: CapabilityDeclaration;
  retryAt: number;
  /** Stable identity for a session resumed after a process restart. */
  bindingContext: string;
  selectModel(selection: Model | null): Model | null;
  driver(previousEpoch: number): ExecutorDriver;
  refresh(): Promise<FamilyProbe>;
}
export interface ExecutorFamily {
  family: AdapterFamily;
  supports(registration: Omit<ExecutorRegistration, "version">): boolean;
  probe(
    registration: ExecutorRegistration,
    cwd: string,
    environment: Record<string, string>,
  ): Promise<FamilyProbe>;
}
