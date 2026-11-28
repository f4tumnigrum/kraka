import * as v from "valibot";
import {
  AttemptIdSchema,
  ContextOperationSchema,
  REQUEST_METHODS,
  type ContextOperation,
  type ContextOperationObservation,
  type ThreadId,
} from "@kraka/protocol";
import { type FirstSendContext, checkCommand, recordCommand, reject } from "./command-receipts";
import type { FirstSendStore } from "./first-send-store";
import { transitionContextOperation } from "./context-operations";
import { SessionBindings } from "./session-binding";
import { invokeTransition, type TransitionChannel } from "./session-transition";
import { matchesAdapterEvent } from "./adapter-contract";
import type { ThreadSessionBinding } from "./executor-records";
import { loadQueue } from "./input-store";
export interface ClearTarget {
  current(): boolean;
  open(binding: ThreadSessionBinding): Promise<TransitionChannel | null>;
}
function save(store: FirstSendStore, operation: ContextOperation) {
  const fresh = operation.action === "clear" && operation.state.kind === "completed";
  store.db.run(
    "INSERT INTO session_clear VALUES(?,?,?,?) ON CONFLICT(delivery) DO UPDATE SET data=excluded.data,fresh=excluded.fresh",
    [operation.threadId, operation.deliveryId, JSON.stringify(operation), Number(fresh)],
  );
  store.sync.recordContextOperation(operation);
}
export function consumeFreshContext(store: FirstSendStore, thread: ThreadId) {
  return !!store.db.run("UPDATE session_clear SET fresh=0 WHERE thread=? AND fresh=1", [thread])
    .changes;
}
export function clearThreadSession(
  ctx: FirstSendContext,
  threadId: ThreadId,
  target: ClearTarget | null,
  start: (job: Promise<void>) => void,
) {
  const store = ctx.transaction,
    address = { kind: "thread" as const, threadId },
    method = REQUEST_METHODS.clearThread;
  const prior = checkCommand(ctx, method, { threadId }, address);
  if (
    !ctx.actor.allows(method.permission, address) ||
    ctx.actor.environmentId !== store.writer.environmentId
  )
    return prior.receipt ?? reject(ctx.commandId, "notFound");
  if (!target?.current()) return reject(ctx.commandId, "unsupported");
  if (prior.receipt) return prior.receipt;
  const binding = new SessionBindings(store, "").get(threadId);
  if (
    !binding ||
    loadQueue(store, threadId, true).rows.length ||
    store.db
      .query(
        "SELECT 1 FROM session_switches WHERE thread=? AND busy=1 UNION ALL SELECT 1 FROM session_clear WHERE thread=? AND json_extract(data,'$.state.kind') IN ('accepted','unknown')",
      )
      .get(threadId, threadId)
  )
    return reject(ctx.commandId, "invalidState");
  const operation = v.parse(ContextOperationSchema, {
    threadId,
    action: "clear",
    deliveryId: crypto.randomUUID(),
    version: "1",
    state: { kind: "accepted", acceptedAt: Date.now() },
  });
  const receipt = recordCommand(ctx, method, { threadId }, address, () => {
    save(store, operation);
    return { kind: "contextOperation", operation };
  });
  if (receipt.kind === "accepted") start(performClear(store, binding, operation, target));
  return receipt;
}
async function performClear(
  store: FirstSendStore,
  prior: ThreadSessionBinding,
  operation: ContextOperation,
  target: ClearTarget,
) {
  let channel: TransitionChannel | null = null;
  const unknown = () =>
    ({
      threadId: operation.threadId,
      deliveryId: operation.deliveryId,
      action: "clear",
      state: { kind: "unknown", observedAt: Date.now() },
    }) as const;
  const publish = (observation: ContextOperationObservation) => {
    const next = transitionContextOperation(operation, observation);
    if (next.kind === "ok" && next.value !== operation) {
      store.db.transaction(() => save(store, next.value))();
      store.sync.notify();
    }
  };
  try {
    channel = await target.open(prior);
    if (
      !channel ||
      !target.current() ||
      channel.session.nativeSessionId !== prior.nativeSessionId ||
      channel.session.instanceId !== prior.instanceId ||
      channel.session.family !== prior.family
    ) {
      publish(unknown());
      return;
    }
    const session = channel.session;
    const events = channel.adapter.events(session, null)[Symbol.asyncIterator]();
    let running = true;
    const matchEvents = async () => {
      while (running) {
        const frame = await events.next();
        if (frame.done) return null;
        if (!matchesAdapterEvent(session, frame.value)) continue;
        const p = frame.value.payload;
        if (
          p.kind === "contextOperation" &&
          p.result.action === "clear" &&
          p.result.threadId === operation.threadId &&
          p.result.deliveryId === operation.deliveryId &&
          p.result.state.kind !== "accepted"
        )
          return p.result;
        if (
          p.kind === "nativeActionCompleted" &&
          p.action === "clear" &&
          p.deliveryId === operation.deliveryId
        ) {
          if (p.result === "failed")
            return {
              action: "clear",
              deliveryId: operation.deliveryId,
              threadId: operation.threadId,
              state: { kind: "failed", failedAt: Date.now(), reason: "operationRejected" },
            } as const;
          if (p.nativeSessionId)
            return {
              action: "clear",
              deliveryId: operation.deliveryId,
              threadId: operation.threadId,
              state: {
                kind: "completed",
                completedAt: Date.now(),
                nativeSessionId: p.nativeSessionId,
              },
            } as const;
        }
      }
      return null;
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observed = matchEvents();
    try {
      const reply = invokeTransition(channel, {
        kind: "nativeAction",
        capability: "clearSession",
        action: "clear",
        target: null,
        deliveryId: operation.deliveryId,
      }).then((r) =>
        r?.kind === "contextOperation" && r.result.state.kind !== "accepted" ? r.result : observed,
      );
      const result = await Promise.race([
        observed.then((r) => r ?? reply),
        reply,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 30000);
        }),
      ]);
      if (
        !result ||
        result.action !== "clear" ||
        result.threadId !== operation.threadId ||
        result.deliveryId !== operation.deliveryId
      ) {
        publish(unknown());
        return;
      }
      if (result.state.kind !== "completed") {
        publish(result);
        return;
      }
      const next = transitionContextOperation(operation, result);
      if (
        next.kind !== "ok" ||
        !target.current() ||
        result.state.nativeSessionId === prior.nativeSessionId
      ) {
        publish(unknown());
        return;
      }
      const bindings = new SessionBindings(store, channel.context, () => save(store, next.value));
      if (
        !(await bindings.replace(prior, {
          ...prior,
          attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
          epoch: prior.epoch + 1,
          nativeSessionId: result.state.nativeSessionId,
        }))
      )
        publish(unknown());
      store.sync.notify();
    } finally {
      running = false;
      clearTimeout(timer);
      void events.return?.().catch(() => {});
    }
  } catch {
    publish(unknown());
  } finally {
    if (channel) await channel.adapter.close(channel.session, "finished");
  }
}
