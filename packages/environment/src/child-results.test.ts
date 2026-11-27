import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ChildResultTransferIdSchema,
  DelegatedChildRecordSchema,
  MessageIdSchema,
} from "@kraka/protocol";
import { prepareChildResultTransfer, transitionChildResultReturn } from "./child-results";

test("a delegated child completion freezes one pending parent return and commits it once", () => {
  const child = v.parse(DelegatedChildRecordSchema, {
    taskId: "task",
    parentThreadId: "parent",
    parentRoundId: "parent-round",
    childCommandId: "child-command",
    childThreadId: "child",
    childRoundId: "child-round",
    instanceId: "codex",
    model: { id: "model-a", options: { reasoning: "high" } },
    requestedMode: "edits",
    effectiveMode: "ask",
    returnTransferId: "return-transfer",
    state: { kind: "completed", result: "Files were checked." },
  });
  expect(prepareChildResultTransfer({ ...child, state: { kind: "working" } })).toMatchObject({
    kind: "rejected",
  });
  const prepared = prepareChildResultTransfer(child);
  if (prepared.kind !== "ok") throw new Error("Expected completed child");
  const pending = prepared.value;
  expect(pending).toMatchObject({
    id: "return-transfer",
    result: "Files were checked.",
    version: "1",
    state: { kind: "pending" },
  });
  const event = {
    transferId: pending.id,
    parentMessageId: v.parse(MessageIdSchema, "return-message"),
    returnedAt: 200,
  };
  const returned = transitionChildResultReturn(pending, event);
  expect(returned).toMatchObject({
    kind: "ok",
    value: { version: "2", state: { kind: "returned" } },
  });
  if (returned.kind !== "ok") throw new Error("Expected parent return");
  expect(transitionChildResultReturn(returned.value, event)).toEqual(returned);
  expect(
    transitionChildResultReturn(returned.value, {
      ...event,
      parentMessageId: v.parse(MessageIdSchema, "other-message"),
    }),
  ).toEqual({
    kind: "rejected",
    reason: "idConflict",
  });
  expect(
    transitionChildResultReturn(pending, {
      ...event,
      transferId: v.parse(ChildResultTransferIdSchema, "other-transfer"),
    }),
  ).toEqual({
    kind: "rejected",
    reason: "wrongDelivery",
  });
});
