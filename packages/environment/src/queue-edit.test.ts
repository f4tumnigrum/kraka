import { expect, test } from "bun:test";
import * as v from "valibot";
import { MessageSchema, RoundSchema, REQUEST_METHODS, type InputContent } from "@kraka/protocol";
import { planQueuedChange, type EditableQueue } from "./queue";
const signed = {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "e",
  connectionId: "c",
  challengeId: "ch",
  challenge: "A".repeat(43),
  signature: "B".repeat(86),
  commandId: "change",
  sequence: 2,
  signer: { kind: "device", deviceId: "d", keyId: "k" },
};
function row(id: string, place: string) {
  return {
    ...v.parse(RoundSchema, {
      id,
      messageId: id,
      threadId: "t",
      place,
      version: "7",
      attempt: { deliveryId: id, attemptId: id, phase: { kind: "filed", gate: "eligible" } },
    }),
    source: "person" as const,
    previous: [],
  };
}
const first = row("first", "7"),
  second = row("second", "12");
const queue: EditableQueue = {
  rows: [first, second],
  decisions: [],
  threadId: first.threadId,
  version: first.version,
};
const message = v.parse(MessageSchema, {
  id: first.messageId,
  roundId: first.id,
  threadId: first.threadId,
  author: { kind: "person", id: "owner" },
  text: "before",
  attachments: [],
  references: [],
  version: "3",
});
const content: InputContent = { text: "draft", attachments: [], references: [] };
const target = { threadId: queue.threadId, roundId: first.id, baseVersion: "7" };
const edit = v.parse(REQUEST_METHODS.editQueued.schema, {
  ...signed,
  method: "input.editQueued",
  payload: { ...target, content },
});
test("a conditional edit keeps message identity and a losing editor receives a recoverable conflict", () => {
  const saved = planQueuedChange(queue, edit, message);
  expect(saved.message?.id).toBe(message.id);
  expect(saved.message?.text).toBe("draft");
  expect(saved.receipt.kind).toBe("accepted");
  const cancel = v.parse(REQUEST_METHODS.cancelQueued.schema, {
    ...signed,
    method: "input.cancelQueued",
    payload: target,
  });
  const cancelled = planQueuedChange(queue, cancel, null);
  const late = planQueuedChange(cancelled.queue, edit, message);
  expect(late.queue).toBe(cancelled.queue);
  expect(late.receipt).toMatchObject({
    kind: "rejected",
    failure: { kind: "queueConflict", reason: "leftQueue" },
  });
  expect(message.text).toBe("before");
});
test("a reorder checks the whole queue version and the exact set of waiting rows", () => {
  const reorder = (ids: string[]) =>
    v.parse(REQUEST_METHODS.reorderQueue.schema, {
      ...signed,
      method: "input.reorderQueue",
      payload: { threadId: queue.threadId, baseVersion: "7", roundIds: ids },
    });
  const moved = planQueuedChange(queue, reorder(["second", "first"]), null);
  expect(moved.queue.rows.map((r) => r.place.toString())).toEqual(["2", "1"]);
  expect(planQueuedChange(moved.queue, reorder(["second", "first"]), null).receipt.kind).toBe(
    "rejected",
  );
  expect(planQueuedChange(queue, reorder(["first", "first"]), null).receipt.kind).toBe("rejected");
});
