import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CapabilityMatrixSchema,
  type AttemptId,
  type NativeRootTurnId,
} from "@kraka/protocol";
import type {
  ProviderAdapter,
  AdapterNormalizerState,
  AdapterSession,
  AdapterInstance,
  ActionPermit,
  AdapterCommand,
  InstanceServiceCommand,
  CapabilityDeclaration,
  AdapterCallResult,
  InstanceServiceResult,
  InvocationResult,
  SessionInvocationResult,
  OpenSessionInput,
  AdapterCapability,
} from "@kraka/environment";
import bundled from "../../../fixtures/executors/codex/basic-turn.jsonl" with { type: "text" };
import { parseReplayRecording, type ReplayRecording } from "./native";
import { translateReplayFrame } from "./translate";
export * from "./recording";
export * from "./native";
export { assertFakeCredentials } from "./fixture-credentials";

export type ReplaySessionHandle = {
  readonly attemptId: AttemptId;
  readonly emitted: Set<string>;
  readonly ready: Promise<void>;
  readonly wake: () => void;
  closed: boolean;
  position: number;
  root: NativeRootTurnId | null;
  state: AdapterNormalizerState<"replay">;
};
type Session = AdapterSession<"replay", ReplaySessionHandle>;
type Instance = AdapterInstance<"replay">;
type ReplayAdapter = ProviderAdapter<"replay", ReplaySessionHandle>;
export type ReplayAdapterFactory = (recording?: ReplayRecording) => ReplayAdapter;
const denied = (reason: "unsupported" | "invalidState" | "alreadyClosed") =>
  ({ kind: "rejected", reason, message: null }) as const;
const ok = <T>(value: T) => ({ kind: "ok", value }) as const;

function declaration(at: number): CapabilityDeclaration<"replay"> {
  const supported = [
    "startSession",
    "submitTextInput",
    "streamResponse",
    "reportToolActivity",
    "reportRoundEnd",
    "selectPermissionMode",
  ];
  const unsupported = {
    kind: "unsupported",
    reason: "Not supported by the basic-turn recording",
  } as const;
  const matrix = v.parse(
    CapabilityMatrixSchema,
    Object.fromEntries(
      CAPABILITY_IDS.map((id) => [id, supported.includes(id) ? { kind: "native" } : unsupported]),
    ),
  );
  const yes = { state: "yes", verifiedAt: at } as const;
  const none = { receipt: "none", deduplicate: "none", query: "none" } as const;
  const steering = { support: unsupported, readReceipt: "no", accepts: [] } as const;
  const request = { afterSessionLoss: "notResumable" } as const;
  return {
    family: "replay",
    version: 1,
    checkedAt: at,
    readiness: { configured: yes, installed: yes, authenticated: yes, model: yes, operation: yes },
    matrix,
    input: none,
    answer: none,
    steering: { queueNext: steering, insertCurrent: steering, restartCurrent: steering },
    requests: { approval: request, question: request },
    permission: { modes: ["ask"], enforcement: "adapter", changeEffective: "now" },
    endReasons: ["completed"],
    childWork: "unsupported",
  };
}

export function createReplayAdapter(
  recording: ReplayRecording = parseReplayRecording(bundled),
): ReplayAdapter {
  const handles = new WeakSet<ReplaySessionHandle>();
  const matches = (instance: Instance) =>
    instance.family === "replay" && instance.instanceId === "replay";
  const owns = (session: Session) =>
    matches(session) &&
    handles.has(session.handle) &&
    session.epoch === 1 &&
    session.nativeSessionId === recording.nativeSessionId;
  async function open({
    instance,
    resume,
    attemptId,
    setup,
  }: OpenSessionInput<"replay">): Promise<AdapterCallResult<Session>> {
    if (
      !matches(instance) ||
      resume !== null ||
      setup.permission.selected !== "ask" ||
      setup.permission.ceiling !== "ask" ||
      setup.model.id !== recording.modelId ||
      setup.additionalDirectories.length ||
      Object.keys(setup.model.options).length ||
      Object.keys(setup.environment).length
    )
      return denied("unsupported");
    const { promise: ready, resolve: wake } = Promise.withResolvers<void>();
    const handle: ReplaySessionHandle = {
      attemptId,
      emitted: new Set(),
      ready,
      wake,
      closed: false,
      position: 0,
      root: null,
      state: {
        family: "replay",
        epoch: 1,
        pendingDeliveries: new Map(),
        partialContent: new Map(),
      },
    };
    handles.add(handle);
    return ok({ ...instance, nativeSessionId: recording.nativeSessionId, epoch: 1, handle });
  }
  async function invoke<C extends InstanceServiceCommand>(
    instance: Instance,
    permit: ActionPermit<"replay", NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  async function invoke<C extends AdapterCommand>(
    session: Session,
    permit: ActionPermit<"replay", NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    target: Session | Instance,
    permit: ActionPermit<"replay", AdapterCapability>,
    command: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>> {
    if (
      !("handle" in target) ||
      command.kind !== "deliverInput" ||
      command.capability !== "submitTextInput" ||
      permit.capability !== command.capability ||
      permit.capabilityVersion !== 1 ||
      permit.support.kind !== "native" ||
      !matches(permit)
    )
      return denied("unsupported");
    if (!owns(target)) return denied("invalidState");
    const h = target.handle;
    if (h.closed) return denied("alreadyClosed");
    if (
      h.position !== 0 ||
      command.attemptId !== h.attemptId ||
      command.input.text !== recording.expectedText ||
      command.input.references.length ||
      command.input.attachments.length
    )
      return denied("invalidState");
    const submitted = recording.frames[6];
    if (!submitted) throw new Error("Recording missing turn/start");
    h.state = {
      ...h.state,
      pendingDeliveries: new Map([
        [
          submitted.requestId,
          { deliveryId: command.deliveryId, attemptId: command.attemptId, subject: "input" },
        ],
      ]),
    };
    h.position = 8;
    h.wake();
    return ok({ kind: "written", deliveryId: command.deliveryId });
  }
  const adapter: ReplayAdapter = {
    async capabilities(instance) {
      return matches(instance) ? ok(declaration(recording.startedAt)) : denied("unsupported");
    },
    open,
    invoke,
    async *events(session, after) {
      if (!owns(session)) throw new Error("Foreign replay handle");
      const h = session.handle;
      if (after !== null && !h.emitted.has(after)) throw new Error("Unknown replay cursor");
      await h.ready;
      let position = after === null ? 8 : Number(after);
      while (!h.closed && position < recording.frames.length) {
        const frame = recording.frames[position++];
        if (!frame) throw new Error("Missing replay frame");
        const normalized = translateReplayFrame(frame, h.state);
        h.state = normalized.state;
        h.position = Math.max(h.position, position);
        for (const payload of normalized.events) {
          if (payload.kind === "roundStarted") h.root = payload.nativeRootTurnId;
          if (payload.kind === "roundEnded" && payload.nativeRootTurnId !== h.root)
            throw new Error("Foreign replay root");
          const eventId = String(position);
          h.emitted.add(eventId);
          yield {
            family: "replay",
            instanceId: session.instanceId,
            sessionId: recording.nativeSessionId,
            epoch: session.epoch,
            eventId,
            payload,
          };
        }
      }
    },
    async close(session) {
      if (!owns(session)) return denied("invalidState");
      if (session.handle.closed) return denied("alreadyClosed");
      session.handle.closed = true;
      session.handle.wake();
      return ok(undefined);
    },
  };
  return adapter;
}
