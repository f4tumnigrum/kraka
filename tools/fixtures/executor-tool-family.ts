import * as v from "valibot";
import { createReplayAdapter } from "@kraka/adapter-replay";
import {
  bindExecutorAdapter,
  type AdapterCommand,
  type AdapterCallResult,
  type AdapterSession,
  type AdapterInstance,
  type AdapterEventPayload,
  type ActionPermit,
  type AdapterCapability,
  type ExecutorFamily,
  type InstanceServiceCommand,
  type InstanceServiceResult,
  type SessionInvocationResult,
  type ProviderAdapter,
  type InvocationResult,
  type FamilyProbe,
} from "@kraka/environment";
import {
  ExecutorInstanceIdSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  NativeItemIdSchema,
  NativeRequestIdSchema,
  type AttemptId,
  type NativeSessionId,
} from "@kraka/protocol";

type Handle = {
  attempt: AttemptId;
  session: NativeSessionId;
  events: AdapterEventPayload[];
  wait: ReturnType<typeof Promise.withResolvers<void>>;
  closed: boolean;
};
const handles = new Map<AttemptId, Handle>();
function emit(h: Handle, event: AdapterEventPayload) {
  h.events.push(event);
  h.wait.resolve();
}
export function nativeEvent(
  attempt: AttemptId,
  action: "question" | "approval" | "finish",
  text: string,
) {
  const h = handles.get(attempt);
  if (!h) throw Error("Missing live native attempt");
  if (action === "finish") {
    emit(h, {
      kind: "contentDelta",
      attemptId: attempt,
      itemId: v.parse(NativeItemIdSchema, "summary"),
      role: "assistant",
      text,
      finalText: text,
    });
    emit(h, {
      kind: "roundEnded",
      nativeRootTurnId: v.parse(NativeRootTurnIdSchema, attempt),
      attemptId: attempt,
      endedAt: Date.now(),
      endTimeEvidence: {
        source: "environmentObserved",
        executorEndedAt: null,
        environmentObservedAt: Date.now(),
      },
      outcome: { reason: "completed", nativeReason: null },
    });
  } else {
    const requestId = v.parse(NativeRequestIdSchema, crypto.randomUUID());
    if (action === "approval")
      emit(h, {
        kind: "requestOpened",
        attemptId: attempt,
        requestId,
        recovery: "liveOnly",
        body: {
          kind: "approval",
          tool: "command",
          choices: [{ key: "allow", scope: "once", allowsEdit: false }],
        },
        approval: {
          permission: "term.input",
          choices: [{ kind: "approval", choiceKey: "allow", decision: "allow", scope: "once" }],
        },
      });
    else
      emit(h, {
        kind: "requestOpened",
        attemptId: attempt,
        requestId,
        recovery: "liveOnly",
        body: { kind: "question", questions: [{ key: "title", text: "Title?", choices: [] }] },
      });
  }
}

export async function toolFamily(publish: (data: object) => void): Promise<ExecutorFamily> {
  const sample = await createReplayAdapter().capabilities({
    family: "replay",
    instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
  });
  if (sample.kind !== "ok") throw Error("Missing replay sample");
  const declaration = {
    ...sample.value,
    matrix: {
      ...sample.value.matrix,
      provideTools: { kind: "native" as const },
      answerApprovalChoices: { kind: "native" as const },
      stopRound: { kind: "native" as const },
    },
    permission: { ...sample.value.permission, modes: ["ask", "edits", "open"] as const },
  };
  return {
    family: "replay",
    supports: () => true,
    async probe(reg) {
      const probe: FamilyProbe = {
        declaration,
        bindingContext: reg.instanceId,
        retryAt: Date.now() + 600000,
        binaryVersion: null,
        versionAdvisory: null,
        compatibilityAdvisory: null,
        models: null,
        selectModel(model) {
          return model?.id === "model-b" || model?.id === "model-a" ? model : null;
        },
        refresh: async () => probe,
        driver(epoch) {
          const instance = { family: "replay" as const, instanceId: reg.instanceId };
          type Session = AdapterSession<"replay", Handle>;
          async function invoke<C extends InstanceServiceCommand>(
            target: AdapterInstance<"replay">,
            permit: ActionPermit<"replay", C["capability"]>,
            cmd: C,
          ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
          async function invoke<C extends AdapterCommand>(
            target: Session,
            permit: ActionPermit<"replay", C["capability"]>,
            cmd: C,
          ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
          async function invoke(
            target: Session | AdapterInstance<"replay">,
            _permit: ActionPermit<"replay", AdapterCapability>,
            cmd: AdapterCommand,
          ): Promise<
            AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>
          > {
            if ("handle" in target) {
              const h = target.handle;
              if (cmd.kind === "service" && cmd.capability === "provideTools") {
                publish({ event: "tools", attempt: h.attempt, tools: cmd.request.tools });
                return { kind: "ok", value: { kind: "service", result: null } };
              }
              if (cmd.kind === "deliverInput") {
                publish({ event: "start", attempt: h.attempt, text: cmd.input.text });
                emit(h, {
                  kind: "roundStarted",
                  attemptId: h.attempt,
                  nativeRootTurnId: v.parse(NativeRootTurnIdSchema, h.attempt),
                  at: Date.now(),
                });
                return { kind: "ok", value: { kind: "written", deliveryId: cmd.deliveryId } };
              }
              if (cmd.kind === "stop") {
                publish({ event: "stop", attempt: h.attempt });
                emit(h, {
                  kind: "roundEnded",
                  nativeRootTurnId: v.parse(NativeRootTurnIdSchema, h.attempt),
                  attemptId: h.attempt,
                  endedAt: Date.now(),
                  endTimeEvidence: {
                    source: "environmentObserved",
                    executorEndedAt: null,
                    environmentObservedAt: Date.now(),
                  },
                  outcome: { reason: "stopped", nativeReason: "stopped" },
                });
                return { kind: "ok", value: { kind: "written", deliveryId: cmd.deliveryId } };
              }
              if (cmd.kind === "deliverAnswer") {
                publish({
                  event: "reply",
                  attempt: h.attempt,
                  requestId: cmd.requestId,
                  reply: cmd.reply,
                });
                emit(h, {
                  kind: "deliveryReceived",
                  attemptId: cmd.attemptId,
                  deliveryId: cmd.deliveryId,
                  receipt: { kind: "answer", requestId: cmd.requestId, sessionId: h.session },
                });
                return { kind: "ok", value: { kind: "written", deliveryId: cmd.deliveryId } };
              }
            }
            return { kind: "rejected", reason: "unsupported", message: null };
          }
          const adapter: ProviderAdapter<"replay", Handle> = {
            async capabilities() {
              return { kind: "ok", value: declaration };
            },
            async open({ attemptId, resume, setup }) {
              const session = resume ?? v.parse(NativeSessionIdSchema, crypto.randomUUID());
              const handle: Handle = {
                attempt: attemptId,
                session,
                closed: false,
                events: [],
                wait: Promise.withResolvers<void>(),
              };
              handles.set(attemptId, handle);
              publish({
                event: "open",
                attempt: attemptId,
                instanceId: reg.instanceId,
                setup,
                session,
                epoch: epoch + 1,
              });
              return {
                kind: "ok",
                value: { ...instance, epoch: epoch + 1, nativeSessionId: session, handle },
              };
            },
            invoke,
            async *events(s) {
              let n = 0;
              const h = s.handle;
              while (!h.closed) {
                const event = h.events.shift();
                if (event)
                  yield {
                    ...instance,
                    sessionId: h.session,
                    epoch: s.epoch,
                    eventId: String(++n),
                    payload: event,
                  };
                else {
                  h.wait = Promise.withResolvers<void>();
                  await h.wait.promise;
                }
              }
            },
            async close(s) {
              const h = s.handle;
              h.closed = true;
              h.wait.resolve();
              handles.delete(h.attempt);
              return { kind: "ok", value: undefined };
            },
          };
          return bindExecutorAdapter(instance, adapter);
        },
      };
      return probe;
    },
  };
}
