import {
  AdapterFamilySchema,
  AttachmentReferenceSchema,
  AttemptIdSchema,
  RoundSchema,
  type RoundId,
  type MessageId,
  type RoundAttempt,
  type DeliveryId,
  DeliveryIdSchema,
  ExecutorInstanceIdSchema,
  HandoffContextSchema,
  MessageIdSchema,
  MessageReferenceSchema,
  MessageSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  type ThreadId,
  ThreadIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import type { AdapterSessionBinding, DeliveryGuarantee } from "./adapter-contract";
import type { FrozenDelivery } from "./executor-records";
import { type FirstSendStore, readRound } from "./first-send-store";
import {
  type EditableQueue,
  firstPending,
  type InputQueue,
  transitionInputQueue,
  type UnknownDeliveryDecision,
} from "./queue";
import { reject } from "./result";
import type { DeliveryRecovery, RoundReport } from "./round";

export function fileInputRound(
  transaction: FirstSendStore,
  queue: InputQueue,
  roundId: RoundId,
  messageId: MessageId,
  ticket: Pick<RoundAttempt, "attemptId" | "deliveryId">,
) {
  const head = firstPending(queue.rows);
  const { attemptId, deliveryId } = ticket;
  const held =
    head &&
    (head.attempt.phase.kind === "uncertain" ||
      ("gate" in head.attempt.phase && head.attempt.phase.gate === "held"));
  const round = v.parse(RoundSchema, {
    id: roundId,
    threadId: queue.threadId,
    messageId,
    place: String(
      queue.rows.reduce((max, r) => (BigInt(r.place) > max ? BigInt(r.place) : max), 0n) + 1n,
    ),
    version: "1",
    attempt: {
      attemptId,
      deliveryId,
      phase: { kind: "filed", gate: held ? "held" : "eligible" },
    },
  });
  transaction.db.run("INSERT INTO rounds VALUES(?,?,'person')", [round.id, JSON.stringify(round)]);
  transaction.db.run("INSERT INTO deliveries VALUES(?,?,1,NULL)", [deliveryId, round.id]);
  return round;
}

export const nextVersion = (version: string) =>
  v.parse(ObjectVersionSchema, String(BigInt(version) + 1n));
const initial = v.parse(ObjectVersionSchema, "1");
const bindingSchema = v.object({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  nativeSessionId: v.nullable(NativeSessionIdSchema),
  epoch: v.number(),
});
const frozenHeader = v.object({
  target: bindingSchema,
  deliveryId: DeliveryIdSchema,
  attemptId: AttemptIdSchema,
  messageVersion: ObjectVersionSchema,
  input: v.strictObject({
    id: MessageIdSchema,
    text: v.string(),
    references: v.array(MessageReferenceSchema),
    attachments: v.array(AttachmentReferenceSchema),
  }),
  handoff: v.optional(HandoffContextSchema),
});
export type RecoveryScope = { binding: AdapterSessionBinding; input: DeliveryGuarantee };
const sameBinding = (a: AdapterSessionBinding, b: AdapterSessionBinding) =>
  a.family === b.family &&
  a.instanceId === b.instanceId &&
  a.nativeSessionId === b.nativeSessionId &&
  a.epoch === b.epoch;
export function frozenInput(store: FirstSendStore, id: DeliveryId) {
  const raw = store.frozen(id);
  return raw === null ? null : v.parse(frozenHeader, raw);
}
export function queueVersion(store: FirstSendStore, thread: ThreadId) {
  const row = store.db
    .query<{ version: string }, [string]>("SELECT version FROM queues WHERE thread=?")
    .get(thread);
  return row ? v.parse(ObjectVersionSchema, row.version) : initial;
}
export function advanceQueue(store: FirstSendStore, thread: ThreadId) {
  store.db.run("INSERT OR REPLACE INTO queues VALUES(?,?)", [
    thread,
    nextVersion(queueVersion(store, thread)),
  ]);
  store.onQueueChanged?.(thread);
}
const unfinishedRows =
  "json_extract(data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered')";
export function threadRounds(store: FirstSendStore, thread: ThreadId, unfinishedOnly = false) {
  const rows = store.db
    .query<{ id: string; source: "person" | "automation" }, [string]>(
      `SELECT id,source FROM rounds WHERE json_extract(data,'$.threadId')=? ${unfinishedOnly ? "AND " + unfinishedRows : ""} ORDER BY length(json_extract(data,'$.place')),json_extract(data,'$.place'),rowid`,
    )
    .all(thread);
  return rows.map(({ id, source }) => {
    const round = readRound(store.db, id);
    if (!round) throw Error("Round missing");
    return { ...round, source, previous: round.attempts?.slice(0, -1) ?? [] };
  });
}
export function loadQueue(
  store: FirstSendStore,
  threadId: ThreadId,
  unfinishedOnly = false,
): EditableQueue {
  return {
    threadId,
    version: queueVersion(store, threadId),
    rows: threadRounds(store, threadId, unfinishedOnly),
    decisions: [],
  };
}
export function inputHistory(store: FirstSendStore, threadId: ThreadId) {
  const rounds = threadRounds(store, threadId).map(({ source, previous, ...round }) => round);
  const messages = store.db
    .query<{ data: string }, [string]>(
      "SELECT data FROM messages WHERE json_extract(data,'$.threadId')=? ORDER BY rowid",
    )
    .all(threadId)
    .map((row) => v.parse(MessageSchema, JSON.parse(row.data)));
  return { rounds, messages, version: queueVersion(store, threadId) };
}
export function persistQueue(
  store: FirstSendStore,
  before: EditableQueue,
  after: InputQueue,
  decision?: UnknownDeliveryDecision,
) {
  let changed = false;
  for (const [i, row] of after.rows.entries()) {
    const prior = before.rows[i];
    if (!prior || row.id !== prior.id) throw Error("Queue identity changed");
    if (Bun.deepEquals(row, prior)) continue;
    const round = readRound(store.db, row.id);
    if (!round) throw Error("Round missing");
    const priorHistory = round.attempts ?? [];
    const attempts = [...row.previous, row.attempt].map((attempt) => {
      const known = priorHistory.find((item) => item.attemptId === attempt.attemptId);
      const resumed =
        prior.attempt.phase.kind === "recovering" &&
        row.source === "automation" &&
        attempt.attemptId === row.attempt.attemptId &&
        row.attempt.phase.kind === "armed";
      const origin =
        resumed && known?.origin.kind !== "userResend"
          ? { kind: "automaticContinuation" as const }
          : (known?.origin ??
            (decision?.kind === "resend" && attempt.attemptId === decision.newAttemptId
              ? {
                  kind: "userResend" as const,
                  commandId: decision.commandId,
                  target: decision.target,
                }
              : { kind: "initial" as const }));
      return { ...attempt, origin };
    });
    if (row.attempt.deliveryId !== prior.attempt.deliveryId) {
      store.db.run("UPDATE deliveries SET pending=0 WHERE id=?", [prior.attempt.deliveryId]);
      store.db.run("INSERT INTO deliveries VALUES(?,?,1,NULL)", [row.attempt.deliveryId, row.id]);
    }
    store.setPhase(
      { ...round, place: row.place, attempt: row.attempt, attempts },
      row.attempt.phase,
    );
    changed = true;
  }
  if (changed) advanceQueue(store, before.threadId);
}
function recoveryFor(
  store: FirstSendStore,
  id: DeliveryId,
  scope?: RecoveryScope,
): DeliveryRecovery {
  if (!scope) return "none";
  const row = store.db
    .query<{ data: string }, [string]>("SELECT data FROM input_guarantees WHERE delivery=?")
    .get(id);
  if (!row) return "none";
  const scopeValue = v.picklist(["none", "unknown", "sameSession", "acrossRestart"]);
  const saved = v.safeParse(
    v.object({
      binding: bindingSchema,
      input: v.object({ deduplicate: scopeValue, query: scopeValue }),
    }),
    JSON.parse(row.data),
  );
  if (!saved.success) return "none";
  const original = saved.output;
  if (!sameBinding(original.binding, scope.binding)) return "none";
  for (const key of ["deduplicate", "query"] as const)
    if (original.input[key] === "acrossRestart" && scope.input[key] === "acrossRestart") return key;
  return "none";
}
export function recoverQueues(store: FirstSendStore, scope?: RecoveryScope) {
  store.db.transaction(() => {
    const threads = store.db
      .query<{ thread: string }, []>(
        "SELECT DISTINCT json_extract(r.data,'$.threadId') thread FROM deliveries d JOIN rounds r ON r.id=d.round WHERE d.pending=1",
      )
      .all();
    for (const { thread } of threads) {
      const queue = loadQueue(store, v.parse(ThreadIdSchema, thread), true);
      const capabilities = new Map(
        queue.rows.map((r) => [
          r.attempt.attemptId,
          recoveryFor(store, r.attempt.deliveryId, scope),
        ]),
      );
      const next = transitionInputQueue(queue, { kind: "restart", capabilities });
      if (next.kind === "ok") {
        const ready = store.db
          .query<{ round: string }, [string]>(
            "SELECT r.id AS round FROM ready_dispatch d JOIN rounds r ON r.id=d.round WHERE json_extract(r.data,'$.threadId')=?",
          )
          .get(thread);
        if (ready) {
          const original = queue.rows.find((r) => r.id === ready.round);
          if (
            original &&
            original.attempt.phase.kind === "filed" &&
            original.attempt.phase.gate === "eligible"
          ) {
            const rows = next.value.rows.map((r) => (r.id === original.id ? original : r));
            persistQueue(store, queue, { ...next.value, rows });
            continue;
          }
        }
        persistQueue(store, queue, next.value);
      }
    }
  })();
}
export function claimNext(
  store: FirstSendStore,
  threadId: ThreadId,
  delivery: FrozenDelivery,
  guarantee: DeliveryGuarantee,
) {
  return store.db.transaction(() => {
    const queue = loadQueue(store, threadId);
    const head = firstPending(queue.rows);
    if (head?.attempt.deliveryId !== delivery.deliveryId || head.messageId !== delivery.input.id)
      return reject("wrongDelivery");
    const next = transitionInputQueue(queue, { kind: "claim", target: delivery.attemptId });
    if (next.kind === "rejected") return next;
    const old = frozenInput(store, delivery.deliveryId);
    if (
      old &&
      (!sameBinding(old.target, delivery.target) ||
        old.deliveryId !== delivery.deliveryId ||
        old.attemptId !== delivery.attemptId ||
        old.input.id !== delivery.input.id)
    )
      return reject("wrongDelivery");
    if (!old) {
      const message = store.db
        .query<{ data: string }, [string]>("SELECT data FROM messages WHERE id=?")
        .get(head.messageId);
      if (!message || JSON.parse(message.data).version !== delivery.messageVersion)
        return reject("invalidState");
      store.freeze(delivery);
    }
    store.db.run("INSERT OR IGNORE INTO input_guarantees VALUES(?,?)", [
      delivery.deliveryId,
      JSON.stringify({ binding: delivery.target, input: guarantee }),
    ]);
    persistQueue(store, queue, next.value);
    return { kind: "ok" as const, value: old ?? delivery };
  })();
}
export function recordInputEvidence(
  store: FirstSendStore,
  binding: AdapterSessionBinding,
  report: RoundReport,
) {
  return store.db.transaction(() => {
    const row = store.db
      .query<{ round: string }, [string]>("SELECT round FROM deliveries WHERE id=?")
      .get(report.deliveryId);
    const frozen = frozenInput(store, report.deliveryId);
    if (
      !row ||
      !frozen ||
      !sameBinding(frozen.target, binding) ||
      frozen.attemptId !== report.attemptId
    )
      return reject("wrongDelivery");
    if (report.kind === "received" && report.proof.sessionId !== binding.nativeSessionId)
      return reject("wrongDelivery");
    if ("root" in report && report.root.sessionId !== binding.nativeSessionId)
      return reject("wrongNativeRoot");
    const round = readRound(store.db, row.round);
    if (!round) return reject("wrongAttempt");
    const queue = loadQueue(store, round.threadId);
    const next = transitionInputQueue(queue, { kind: "report", report });
    if (next.kind === "ok") persistQueue(store, queue, next.value);
    return next;
  })();
}
