import * as v from "valibot";
import {
  QueuePositionSchema,
  ObjectVersionSchema,
  type ObjectVersion,
  type SignedRequest,
  type CommandReceipt,
  type Message,
  type QueueUpdate,
} from "@kraka/protocol";
import type {
  AttemptId,
  CommandId,
  DeliveryId,
  Round,
  RoundAttempt,
  ThreadId,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";
import {
  recoverInputDelivery,
  transitionRound,
  type DeliveryRecovery,
  type RoundReport,
} from "./round";

export type QueueRow = Pick<Round, "id" | "messageId" | "place" | "attempt"> & {
  source: "person" | "automation";
  previous: readonly RoundAttempt[];
};
export type UnknownDeliveryDecision = { commandId: CommandId; target: AttemptId } & (
  | { kind: "drop" }
  | { kind: "resend"; newAttemptId: AttemptId; newDeliveryId: DeliveryId }
);
/** A queue contains one thread's current rows. Its owner commits a numbered decision and its changed rows together. */
export type InputQueue = {
  threadId: ThreadId;
  rows: readonly QueueRow[];
  decisions: readonly UnknownDeliveryDecision[];
};
export type QueueEvent =
  | { kind: "claim"; target: AttemptId }
  | { kind: "release" }
  | { kind: "restart"; capabilities: ReadonlyMap<AttemptId, DeliveryRecovery> }
  | UnknownDeliveryDecision
  | { kind: "report"; report: RoundReport };

export function firstPending(rows: readonly QueueRow[]) {
  let head: QueueRow | undefined;
  for (const row of rows) {
    switch (row.attempt.phase.kind) {
      case "notDelivered":
      case "endedEarly":
      case "finished":
        continue;
    }
    if (!head || BigInt(row.place) < BigInt(head.place)) head = row;
  }
  return head;
}
function release(row: QueueRow): QueueRow {
  const phase = row.attempt.phase;
  if ((phase.kind !== "filed" && phase.kind !== "recovering") || phase.gate === "eligible")
    return row;
  return { ...row, attempt: { ...row.attempt, phase: { ...phase, gate: "eligible" } } };
}
function sameDecision(a: UnknownDeliveryDecision, b: UnknownDeliveryDecision) {
  return (
    a.target === b.target &&
    (a.kind === "drop"
      ? b.kind === "drop"
      : b.kind === "resend" &&
        a.newAttemptId === b.newAttemptId &&
        a.newDeliveryId === b.newDeliveryId)
  );
}

/** Claim checks the oldest unfinished row. Late reports address the original attempt, including after a numbered resend. */
export function transitionInputQueue(
  queue: InputQueue,
  event: QueueEvent,
): TransitionResult<InputQueue> {
  const rows = queue.rows;
  switch (event.kind) {
    case "restart": {
      const restartRows = rows.map((row) => ({
        ...row,
        attempt: {
          ...row.attempt,
          phase: recoverInputDelivery(
            row.attempt.phase,
            row.source,
            event.capabilities.get(row.attempt.attemptId) ?? "none",
          ),
        },
      }));
      // A human head holds the whole queue. Row order and previous attempts survive a restart.
      const head = firstPending(restartRows);
      if (head?.source !== "person") return ok({ ...queue, rows: restartRows });
      return ok({
        ...queue,
        rows: restartRows.map((row) => {
          const p = row.attempt.phase;
          return p.kind === "filed" || p.kind === "recovering"
            ? { ...row, attempt: { ...row.attempt, phase: { ...p, gate: "held" } } }
            : row;
        }),
      });
    }
    case "release":
      if (firstPending(rows)?.attempt.phase.kind === "uncertain") return reject("queueHeld");
      return ok({ ...queue, rows: rows.map(release) });
    case "claim": {
      const head = firstPending(rows);
      if (!head || head.attempt.attemptId !== event.target) return reject("notQueueHead");
      const phase = head.attempt.phase;
      if (phase.kind === "uncertain") return reject("queueHeld");
      if (phase.kind !== "filed" && phase.kind !== "recovering") return reject("invalidState");
      if (phase.gate === "held") return reject("queueHeld");
      if (phase.kind === "recovering" && phase.action === "inspectInput")
        return reject("invalidState");
      return ok({
        ...queue,
        rows: rows.map((row) =>
          row === head ? { ...row, attempt: { ...row.attempt, phase: { kind: "armed" } } } : row,
        ),
      });
    }
    case "resend":
    case "drop": {
      const prior = queue.decisions.find((decision) => decision.commandId === event.commandId);
      if (prior) return sameDecision(prior, event) ? ok(queue) : reject("idConflict");
      const head = firstPending(rows);
      if (!head || head.attempt.attemptId !== event.target) return reject("notQueueHead");
      if (head.attempt.phase.kind !== "uncertain") return reject("invalidState");
      let replacement: QueueRow;
      if (event.kind === "drop") {
        replacement = {
          ...head,
          attempt: {
            ...head.attempt,
            phase: { kind: "notDelivered", reason: "userAbandoned", lateReceipt: null },
          },
        };
      } else {
        if (
          rows.some((row) =>
            [row.attempt, ...row.previous].some(
              (a) => a.attemptId === event.newAttemptId || a.deliveryId === event.newDeliveryId,
            ),
          )
        )
          return reject("idConflict");
        replacement = {
          ...head,
          previous: [...head.previous, head.attempt],
          attempt: {
            attemptId: event.newAttemptId,
            deliveryId: event.newDeliveryId,
            phase: { kind: "filed", gate: "eligible" },
          },
        };
      }
      return ok({
        ...queue,
        rows: rows.map((row) => (row === head ? replacement : release(row))),
        decisions: [...queue.decisions, event],
      });
    }
    case "report": {
      const target = event.report.attemptId;
      for (const row of rows) {
        const current = row.attempt.attemptId === target;
        const attempt = current ? row.attempt : row.previous.find((a) => a.attemptId === target);
        if (!attempt) continue;
        const next = transitionRound(attempt, event.report);
        if (next.kind === "rejected") return next;
        const updated: RoundAttempt = { ...attempt, phase: next.value };
        const replacement = current
          ? { ...row, attempt: updated }
          : { ...row, previous: row.previous.map((a) => (a === attempt ? updated : a)) };
        return ok({ ...queue, rows: rows.map((r) => (r === row ? replacement : r)) });
      }
      return reject("wrongAttempt");
    }
    default:
      return unexpected(event);
  }
}

/** The writer reads this projection and the message in the same transaction. Persist changed rows, versions and the numbered receipt together. */
export type EditableQueue = Omit<InputQueue, "rows"> & {
  version: ObjectVersion;
  rows: readonly (QueueRow & { version: ObjectVersion })[];
};
type QueuedRequest = Extract<
  SignedRequest,
  { method: "input.editQueued" | "input.cancelQueued" | "input.reorderQueue" }
>;
type QueueMutation = { queue: EditableQueue; message: Message | null; receipt: CommandReceipt };
export function planQueuedChange(
  queue: EditableQueue,
  request: QueuedRequest,
  message: Message | null,
): QueueMutation {
  const { commandId } = request;
  const refuse = (
    failure: Extract<CommandReceipt, { kind: "rejected" }>["failure"],
  ): QueueMutation => ({ queue, message: null, receipt: { kind: "rejected", commandId, failure } });
  const conflict = (
    roundId: Round["id"] | null,
    currentVersion: ObjectVersion | null,
    reason: "leftQueue" | "changed",
  ) => refuse({ kind: "queueConflict", threadId: queue.threadId, roundId, currentVersion, reason });
  if (request.payload.threadId !== queue.threadId) return refuse({ kind: "notFound" });
  const nextVersion = (version: ObjectVersion) =>
    v.parse(ObjectVersionSchema, String(BigInt(version) + 1n));
  const version = nextVersion(queue.version);
  const accept = (
    rows: EditableQueue["rows"],
    change: QueueUpdate["change"],
    updated: Message | null = null,
  ): QueueMutation => ({
    queue: { ...queue, rows, version },
    message: updated,
    receipt: {
      kind: "accepted",
      commandId,
      result: { kind: "queueUpdated", update: { threadId: queue.threadId, version, change } },
    },
  });
  if (request.method === "input.reorderQueue") {
    const { roundIds, baseVersion } = request.payload;
    if (baseVersion !== queue.version) return conflict(null, queue.version, "changed");
    const pending = queue.rows
      .filter((row) => !["finished", "endedEarly", "notDelivered"].includes(row.attempt.phase.kind))
      .sort((a, b) => (BigInt(a.place) < BigInt(b.place) ? -1 : 1));
    // Only waiting rows in the same uninterrupted group may trade places.
    const groups = new Map<Round["id"], number>();
    let group = 0;
    for (const row of pending) {
      if (row.attempt.phase.kind === "filed") groups.set(row.id, group);
      else group++;
    }
    if (roundIds.length !== groups.size || new Set(roundIds).size !== groups.size)
      return refuse({ kind: "invalidState" });
    const positions: Extract<QueueUpdate["change"], { kind: "reordered" }>["positions"] = [];
    let waitingIndex = 0;
    for (const [index, row] of pending.entries()) {
      const id = row.attempt.phase.kind === "filed" ? roundIds[waitingIndex++] : row.id;
      if (id === undefined || groups.get(id) !== groups.get(row.id))
        return refuse({ kind: "invalidState" });
      positions.push({ roundId: id, place: v.parse(QueuePositionSchema, String(index + 1)) });
    }
    const places = new Map(positions.map((p) => [p.roundId, p.place]));
    const rows = queue.rows.map((row) => {
      const place = places.get(row.id);
      return place !== undefined && place !== row.place
        ? { ...row, place, version: nextVersion(row.version) }
        : row;
    });
    return accept(rows, { kind: "reordered", positions });
  }
  const { roundId, baseVersion } = request.payload;
  const row = queue.rows.find((r) => r.id === roundId);
  if (row?.attempt.phase.kind !== "filed")
    return conflict(roundId, row?.version ?? null, "leftQueue");
  if (row.version !== baseVersion) return conflict(roundId, row.version, "changed");
  const replace = (updated: EditableQueue["rows"][number]) =>
    queue.rows.map((r) => (r.id === roundId ? updated : r));
  const updated = { ...row, version: nextVersion(row.version) };
  if (request.method === "input.cancelQueued")
    return accept(
      replace({
        ...updated,
        attempt: {
          ...row.attempt,
          phase: { kind: "notDelivered", reason: "userCancelled", lateReceipt: null },
        },
      }),
      { kind: "cancelled", roundId },
    );
  if (
    !message ||
    message.id !== row.messageId ||
    message.roundId !== roundId ||
    message.threadId !== queue.threadId
  )
    return refuse({ kind: "invalidState" });
  const edited = { ...message, ...request.payload.content, version: nextVersion(message.version) };
  return accept(
    replace(updated),
    { kind: "edited", roundId, messageId: edited.id, messageVersion: edited.version },
    edited,
  );
}
