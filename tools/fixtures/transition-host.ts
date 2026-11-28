import * as v from "valibot";
import {
  CapabilityMatrixSchema,
  CAPABILITY_IDS,
  ExecutorInstanceIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  type InputContent,
  type ExecutorInstanceId,
} from "@kraka/protocol";
import {
  SessionBindings,
  readThread,
  readMessage,
  readRound,
  type FirstSendStore,
  type TransitionHost,
  type TransitionChannel,
  type PreviewInput,
  type TransitionFacts,
} from "@kraka/environment";
import { original, tid, rid, input } from "./transition-store";
export type PeerCall = (instance: string, call: object) => Promise<unknown>;
export const stateSchema = v.object({
  instance: v.string(),
  revision: v.number(),
  available: v.boolean(),
  handoff: v.boolean(),
  live: v.boolean(),
  model: v.string(),
  account: v.string(),
  continuationKey: v.string(),
  nativeSession: v.string(),
});
export type PeerState = v.InferOutput<typeof stateSchema>;
export function peerState(instance: string): PeerState {
  return {
    instance,
    revision: 1,
    available: true,
    handoff: true,
    live: true,
    model: "model-" + instance,
    account: "account-" + instance,
    continuationKey: "history-" + instance,
    nativeSession: "native-" + instance,
  };
}
export function proposal(instance = "beta"): PreviewInput {
  return {
    threadId: tid,
    sourceRoundId: rid,
    expectedBinding: original,
    model: { id: "model-" + instance, options: {} },
    targetInstanceId: v.parse(ExecutorInstanceIdSchema, instance),
    proposedInput: input,
  };
}
export function fixtureTransitionHost(
  store: FirstSendStore,
  states: Map<string, PeerState>,
  call: PeerCall,
) {
  const jobs = new Set<Promise<void>>();
  const binding = new SessionBindings(store, "");
  function facts(_actor: Parameters<TransitionHost["facts"]>[0], p: PreviewInput): TransitionFacts {
    const old = binding.get(p.threadId),
      t = states.get(p.targetInstanceId),
      s = old && states.get(old.instanceId),
      thread = readThread(store.db, p.threadId),
      checkout = thread && store.directory(thread);
    const identity = (state: PeerState) => ({
      family: "codex" as const,
      instanceId: v.parse(ExecutorInstanceIdSchema, state.instance),
      account: state.account,
      continuationKey: state.continuationKey,
      checkout: checkout ?? "",
    });
    return {
      binding: old,
      source:
        s && old?.nativeSessionId
          ? {
              ...identity(s),
              nativeSessionId: old.nativeSessionId,
              live: s.live,
              model: { id: s.model, options: {} },
            }
          : null,
      target:
        t?.available && checkout && [t.model, t.model + "-new"].includes(p.model.id)
          ? {
              target: {
                family: "codex",
                account: t.account,
                instanceId: p.targetInstanceId,
                model: p.model,
                permission: { ceiling: "ask", selected: "ask" },
                configurationVersion: v.parse(ObjectVersionSchema, String(t.revision)),
                capabilityVersion: t.revision,
                catalogVersion: t.revision,
              },
              identity: identity(t),
              windowTokens: null,
              acceptsHandoff: t.handoff,
              canResume: true,
              modelChange: "nextTurn",
              acceptsInput: (x: InputContent) => !x.references.length && !x.attachments.length,
            }
          : null,
    };
  }
  async function channel(
    instanceId: ExecutorInstanceId,
    resume: string | null,
    kind: string,
    epoch: number,
    model: string,
  ): Promise<TransitionChannel> {
    const state = states.get(instanceId);
    if (!state) throw Error("Missing peer declaration");
    const nativeSessionId = v.parse(
      NativeSessionIdSchema,
      await call(instanceId, {
        kind:
          kind === "reuseSession" || kind === "changeModel" || kind === "clear" ? "handle" : "open",
        resume,
        model,
      }),
    );
    const session = { family: "codex" as const, instanceId, nativeSessionId, epoch, handle: {} };
    const matrix = v.parse(
      CapabilityMatrixSchema,
      Object.fromEntries(CAPABILITY_IDS.map((k) => [k, { kind: "native" }])),
    );
    return {
      session,
      context: state.continuationKey,
      declaration: { version: state.revision, matrix },
      adapter: {
        events() {
          return {
            [Symbol.asyncIterator]() {
              return {
                async next() {
                  await call(instanceId, { kind: "subscribe", nativeSessionId });
                  return { done: true as const, value: undefined };
                },
              };
            },
          };
        },
        async close() {
          return { kind: "ok", value: undefined };
        },
        async invoke(_s, _permit, cmd) {
          const result = await call(instanceId, {
            kind: "invoke",
            cmd,
            nativeSessionId,
            threadId: tid,
          });
          if (cmd.kind === "nativeAction" && cmd.action === "clear") {
            const native = v.parse(NativeSessionIdSchema, result);
            return {
              kind: "ok",
              value: {
                kind: "contextOperation",
                result: {
                  threadId: tid,
                  deliveryId: cmd.deliveryId,
                  action: "clear",
                  state: { kind: "completed", completedAt: Date.now(), nativeSessionId: native },
                },
              },
            };
          }
          if (cmd.kind === "service" && cmd.request.kind === "changeModel" && result === "changed")
            return {
              kind: "ok",
              value: {
                kind: "service",
                result: { model: cmd.request.model, effectiveAt: "nextTurn" },
              },
            };
          if (cmd.kind === "service" && cmd.request.kind === "handoff" && result === "injected")
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
          return { kind: "rejected", reason: "unsafeToRetry", message: null };
        },
      },
    };
  }
  const host: TransitionHost = {
    facts,
    open: (p) =>
      channel(
        p.target.instanceId,
        p.kind === "resumeSession"
          ? p.nativeSessionId
          : p.kind === "createWithHandoff"
            ? null
            : (p.expectedBinding?.nativeSessionId ?? null),
        p.kind,
        (p.expectedBinding?.epoch ?? 0) + 1,
        p.target.model.id,
      ),
    clearTarget(_actor, id) {
      const old = binding.get(id),
        s = old && states.get(old.instanceId);
      return old && s
        ? {
            current: () => s.available,
            open: () => channel(old.instanceId, old.nativeSessionId, "clear", old.epoch, s.model),
          }
        : null;
    },
    ready(ch, roundId) {
      const round = readRound(store.db, roundId),
        message = round && readMessage(store.db, round.messageId);
      if (!round || !message) throw Error("No committed first input");
      const work = call(ch.session.instanceId, {
        kind: "input",
        text: message.text,
        nativeSessionId: ch.session.nativeSessionId,
      }).then(() => {});
      jobs.add(work);
      void work.finally(() => jobs.delete(work)).catch(() => {});
    },
  };
  return { host, jobs };
}
