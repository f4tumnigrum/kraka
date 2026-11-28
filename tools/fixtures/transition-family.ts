import * as v from "valibot";
import { createReplayAdapter } from "@kraka/adapter-replay";
import {
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  ExecutorInstanceIdSchema,
  type AttemptId,
  type NativeSessionId,
} from "@kraka/protocol";
import {
  bindExecutorAdapter,
  type AdapterCommand,
  type AdapterCallResult,
  type AdapterSession,
  type AdapterInstance,
  type AdapterCapability,
  type ActionPermit,
  type InstanceServiceCommand,
  type InstanceServiceResult,
  type SessionInvocationResult,
  type InvocationResult,
  type ExecutorFamily,
  type ExecutorSession,
  type FamilyProbe,
  type ProviderAdapter,
} from "@kraka/environment";
import { stateSchema, type PeerCall } from "./transition-host";
import { tid } from "./transition-store";
export function peerFamily(call: PeerCall): ExecutorFamily {
  return {
    family: "codex",
    supports: () => true,
    async probe(reg, cwd) {
      const fixture = await createReplayAdapter().capabilities({
        family: "replay",
        instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
      });
      if (fixture.kind !== "ok") throw Error("No base capability declaration");
      const base = fixture.value;
      async function discover(): Promise<FamilyProbe> {
        const state = v.parse(stateSchema, await call(reg.instanceId, { kind: "declare" }));
        const instance = { instanceId: reg.instanceId, family: "codex" as const };
        const native = { kind: "native" as const };
        const declaration = {
          ...base,
          family: instance.family,
          version: state.revision,
          readiness: {
            ...base.readiness,
            operation: {
              state: state.available ? ("yes" as const) : ("no" as const),
              verifiedAt: 1,
            },
          },
          matrix: {
            ...base.matrix,
            resumeSessionAfterProcessExit: native,
            changeModel: native,
            clearSession: native,
          },
        };
        type Handle = {
          attemptId: AttemptId;
          sent: ReturnType<typeof Promise.withResolvers<boolean>>;
        };
        type Session = AdapterSession<"codex", Handle>;
        function driver(epoch: number, live = false) {
          async function invoke<C extends InstanceServiceCommand>(
            i: AdapterInstance<"codex">,
            p: ActionPermit<"codex", C["capability"]>,
            c: C,
          ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
          async function invoke<C extends AdapterCommand>(
            s: Session,
            p: ActionPermit<"codex", C["capability"]>,
            c: C,
          ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
          async function invoke(
            target: Session | AdapterInstance<"codex">,
            _p: ActionPermit<"codex", AdapterCapability>,
            cmd: AdapterCommand,
          ): Promise<
            AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>
          > {
            if (!("handle" in target))
              return { kind: "rejected", reason: "unsupported", message: null };
            const nativeSessionId = target.nativeSessionId;
            if (cmd.kind === "deliverInput") {
              await call(reg.instanceId, { kind: "input", nativeSessionId, text: cmd.input.text });
              target.handle.sent.resolve(true);
              return { kind: "ok", value: { kind: "written", deliveryId: cmd.deliveryId } };
            }
            const ack = await call(reg.instanceId, {
              kind: "invoke",
              cmd,
              nativeSessionId,
              threadId: tid,
            });
            if (cmd.kind === "nativeAction" && cmd.action === "clear")
              return {
                kind: "ok",
                value: {
                  kind: "contextOperation",
                  result: {
                    threadId: tid,
                    deliveryId: cmd.deliveryId,
                    action: "clear",
                    state: {
                      kind: "completed",
                      nativeSessionId: v.parse(NativeSessionIdSchema, ack),
                      completedAt: Date.now(),
                    },
                  },
                },
              };
            if (cmd.kind === "service" && cmd.request.kind === "handoff" && ack === "injected")
              return {
                kind: "ok",
                value: {
                  kind: "service",
                  result: {
                    kind: "injected",
                    transferId: cmd.request.transferId,
                    deliveryId: cmd.deliveryId,
                    nativeSessionId,
                  },
                },
              };
            if (cmd.kind === "service" && cmd.request.kind === "changeModel" && ack === "changed")
              return {
                kind: "ok",
                value: {
                  kind: "service",
                  result: { model: cmd.request.model, effectiveAt: "nextTurn" },
                },
              };
            return { kind: "rejected", reason: "unsafeToRetry", message: null };
          }
          const adapter: ProviderAdapter<"codex", Handle> = {
            invoke,
            capabilities: async () => ({ kind: "ok", value: declaration }),
            async open({ attemptId, resume, setup }) {
              const id = await call(reg.instanceId, {
                kind: live ? "handle" : "open",
                resume,
                model: setup.model.id,
              });
              return {
                kind: "ok",
                value: {
                  ...instance,
                  nativeSessionId: v.parse(NativeSessionIdSchema, id),
                  epoch: epoch + 1,
                  handle: { attemptId, sent: Promise.withResolvers<boolean>() },
                },
              };
            },
            async *events(session) {
              if (!session.nativeSessionId) return;
              await call(reg.instanceId, {
                kind: "subscribe",
                nativeSessionId: session.nativeSessionId,
              });
              if (!(await session.handle.sent.promise)) return;
              const root = v.parse(NativeRootTurnIdSchema, "root-" + session.handle.attemptId),
                common = { ...instance, sessionId: session.nativeSessionId, epoch: session.epoch },
                attemptId = session.handle.attemptId;
              yield {
                ...common,
                eventId: "1",
                payload: { kind: "roundStarted", attemptId, nativeRootTurnId: root, at: 1 },
              };
              yield {
                ...common,
                eventId: "2",
                payload: {
                  kind: "roundEnded",
                  attemptId,
                  nativeRootTurnId: root,
                  endedAt: 2,
                  endTimeEvidence: {
                    source: "executorReported",
                    executorEndedAt: 2,
                    environmentObservedAt: null,
                  },
                  outcome: { reason: "completed", nativeReason: null },
                },
              };
            },
            async close(s) {
              s.handle.sent.resolve(false);
              return { kind: "ok", value: undefined };
            },
          };
          return bindExecutorAdapter(instance, adapter);
        }
        const model = { id: state.model, options: {} };
        return {
          declaration,
          bindingContext: state.instance + "-context",
          retryAt: Date.now() + 300000,
          binaryVersion: "1",
          compatibilityAdvisory: null,
          versionAdvisory: null,
          models: {
            checkedAt: state.revision,
            models: [state.model, state.model + "-new"].map((id, index) => ({
              id,
              slug: id,
              displayName: id,
              isDefault: !index,
              options: {},
            })),
          },
          selectModel: (m) =>
            !m ? model : [state.model, state.model + "-new"].includes(m.id) ? m : null,
          refresh: discover,
          driver,
          sessionTransition: {
            account: state.account,
            continuationKey: state.continuationKey,
            modelChange: "nextTurn",
            handoff: state.handoff,
            ...(state.live
              ? {
                  hasLive: (b) => !!b.nativeSessionId && b.instanceId === reg.instanceId,
                  live: async (b, attempt) => {
                    const result = await driver(b.epoch, true).open(b.nativeSessionId, attempt, {
                      workingDirectory: cwd,
                      additionalDirectories: [],
                      environment: {},
                      model,
                      permission: reg.permission,
                    });
                    return result.kind === "ok" ? result.value : null;
                  },
                }
              : {}),
          },
        };
      }
      return discover();
    },
  };
}
