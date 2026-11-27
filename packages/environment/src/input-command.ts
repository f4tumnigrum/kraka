import {
  AttemptIdSchema,
  type CommandReceipt,
  DeliveryIdSchema,
  MessageSchema,
  REQUEST_METHODS,
  RoundSchema,
  RoundIdSchema,
  type SignedRequest,
  type ThreadId,
  type Round,
} from "@kraka/protocol";
import * as v from "valibot";
import { type LocalActor, recordCommand } from "./command-receipts";
import { type FirstSendStore, readMessage, readRound, readThread } from "./first-send-store";
import { fileInputRound, advanceQueue, loadQueue, nextVersion, persistQueue } from "./input-store";
import {
  firstPending,
  planQueuedChange,
  transitionInputQueue,
  type UnknownDeliveryDecision,
} from "./queue";

export const inputMethods = [
  REQUEST_METHODS.sendInput,
  REQUEST_METHODS.steerInput,
  REQUEST_METHODS.releaseQueue,
  REQUEST_METHODS.resendUnknownInput,
  REQUEST_METHODS.dropUnknownInput,
  REQUEST_METHODS.editQueued,
  REQUEST_METHODS.cancelQueued,
  REQUEST_METHODS.reorderQueue,
] as const;
type InputCommand = Extract<SignedRequest, { method: (typeof inputMethods)[number]["method"] }>;
export function applyInputCommand({
  actor,
  command,
  transaction,
  supportsSteer,
}: {
  actor: LocalActor;
  command: InputCommand;
  transaction: FirstSendStore;
  supportsSteer?: (id: string) => boolean;
}): CommandReceipt {
  const { threadId } = command.payload,
    { commandId } = command;
  const target = { kind: "thread" as const, threadId };
  const operation = inputMethods.find((o) => o.method === command.method);
  if (!operation) throw Error("Unknown input method");
  const refuse = (
    kind: "notFound" | "invalidState" | "unsupported" | "notQueueHead" | "queueHeld" | "idConflict",
  ): CommandReceipt => ({ kind: "rejected", commandId, failure: { kind } });
  return recordCommand(
    { actor, commandId, transaction },
    operation,
    command.payload,
    target,
    () => {
      const thread = readThread(transaction.db, threadId);
      if (!thread) return refuse("notFound");
      const queue = loadQueue(transaction, threadId);
      const head = firstPending(queue.rows);
      if (
        command.method === "input.editQueued" ||
        command.method === "input.cancelQueued" ||
        command.method === "input.reorderQueue"
      ) {
        const row =
          "roundId" in command.payload
            ? queue.rows.find(
                (r) => "roundId" in command.payload && r.id === command.payload.roundId,
              )
            : undefined;
        const change = planQueuedChange(
          queue,
          command,
          row ? readMessage(transaction.db, row.messageId) : null,
        );
        if (change.receipt.kind === "accepted") {
          persistQueue(transaction, queue, change.queue);
          transaction.db.run("INSERT OR REPLACE INTO queues VALUES(?,?)", [
            threadId,
            change.queue.version,
          ]);
          if (change.message) {
            transaction.sync.record([{ objectType: "message", value: change.message }]);
            transaction.db.run("UPDATE messages SET data=? WHERE id=?", [
              JSON.stringify(change.message),
              change.message.id,
            ]);
          }
        }
        return change.receipt;
      }
      if (command.method === "input.send" || command.method === "input.steer") {
        if (!transaction.directory(thread)) return refuse("invalidState");
        const { content } = command.payload;
        if (content.references.length || content.attachments.length) return refuse("unsupported");
        let active = false;
        if (command.method === "input.steer") {
          if (
            head?.attempt.attemptId !== command.payload.attemptId ||
            head.attempt.phase.kind !== "working"
          )
            return refuse("invalidState");
          if (command.payload.mode === "restartCurrent") return refuse("unsupported");
          active = command.payload.mode === "insertCurrent";
          if (active && !supportsSteer?.(head.attempt.attemptId)) return refuse("unsupported");
        }
        const roundId = active && head ? head.id : v.parse(RoundIdSchema, crypto.randomUUID());
        const message = v.parse(MessageSchema, {
          id: crypto.randomUUID(),
          threadId,
          roundId,
          author: { kind: "person", id: actor.id },
          ...content,
          version: "1",
        });
        const deliveryId = v.parse(DeliveryIdSchema, crypto.randomUUID());
        const attemptId =
          active && head ? head.attempt.attemptId : v.parse(AttemptIdSchema, crypto.randomUUID());
        transaction.db.run("INSERT INTO messages VALUES(?,?)", [
          message.id,
          JSON.stringify(message),
        ]);
        let round: Round;
        if (active && head) {
          const original = readRound(transaction.db, head.id);
          if (!original) throw Error("Missing active round");
          const steering = [
            ...(original.steering ?? []),
            { attemptId, messageId: message.id, state: "pending" },
          ];
          round = v.parse(RoundSchema, {
            ...original,
            version: nextVersion(original.version),
            steering,
          });
          transaction.db.run("UPDATE rounds SET data=? WHERE id=?", [
            JSON.stringify(round),
            head.id,
          ]);
        } else {
          round = fileInputRound(transaction, queue, roundId, message.id, {
            attemptId,
            deliveryId,
          });
        }
        transaction.sync.record([
          { objectType: "message", value: message },
          { objectType: "round", value: round },
        ]);
        advanceQueue(transaction, threadId);
        return {
          kind: "inputScheduled",
          messageId: message.id,
          roundId,
          attemptId,
          deliveryId,
        };
      }
      let event: UnknownDeliveryDecision | { kind: "release" };
      if (command.method === "input.releaseQueue") {
        if (thread.worktreeId && !transaction.directory(thread)) return refuse("queueHeld");
        event = { kind: "release" };
      } else {
        const target = command.payload.attemptId;
        if (
          !queue.rows.some(
            (r) => r.attempt.attemptId === target || r.previous.some((a) => a.attemptId === target),
          )
        )
          return refuse("notFound");
        if (head?.attempt.attemptId !== target) return refuse("notQueueHead");
        if (head.attempt.phase.kind !== "uncertain") return refuse("invalidState");
        event =
          command.method === "input.dropUnknown"
            ? { kind: "drop", target, commandId }
            : {
                kind: "resend",
                target,
                commandId,
                newAttemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
                newDeliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
              };
      }
      const next = transitionInputQueue(queue, event);
      if (next.kind === "rejected")
        return refuse(
          next.reason === "queueHeld" ||
            next.reason === "notQueueHead" ||
            next.reason === "idConflict"
            ? next.reason
            : "invalidState",
        );
      persistQueue(transaction, queue, next.value, event.kind === "release" ? undefined : event);
      if (event.kind !== "release")
        transaction.db.run("INSERT INTO input_decisions VALUES(?,?,?,?)", [
          actor.id,
          commandId,
          threadId,
          JSON.stringify(event),
        ]);
      if (event.kind === "resend" && head)
        return {
          kind: "inputScheduled",
          messageId: head.messageId,
          roundId: head.id,
          attemptId: event.newAttemptId,
          deliveryId: event.newDeliveryId,
        };
      return { kind: "actionAccepted" };
    },
  );
}
export function recordSteerRead(
  store: FirstSendStore,
  threadId: ThreadId,
  attemptId: string,
  messageId: string,
) {
  const row = loadQueue(store, threadId).rows.find((r) => r.attempt.attemptId === attemptId);
  if (!row) return false;
  const round = readRound(store.db, row.id);
  const steer = round?.steering?.find(
    (s) => s.messageId === messageId && s.attemptId === attemptId,
  );
  if (!round || !steer) return false;
  if (steer.state === "pending") {
    store.db.transaction(() => {
      steer.state = "completed";
      const updated = { ...round, version: nextVersion(round.version) };
      store.sync.record([{ objectType: "round", value: updated }]);
      store.db.run("UPDATE rounds SET data=? WHERE id=?", [JSON.stringify(updated), round.id]);
      advanceQueue(store, threadId);
    })();
    store.sync.notify();
  }
  return true;
}
