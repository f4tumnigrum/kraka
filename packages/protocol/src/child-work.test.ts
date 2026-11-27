import { expect, test } from "bun:test";
import * as v from "valibot";
import { ChildLaunchSchema, ChildStatusSchema, DelegatedChildRecordSchema } from "./index";

test("child launch can freeze executor, model and requested mode while old callers keep defaults", () => {
  const original = {
    childCommandId: "child-command",
    projectId: "project",
    instruction: "Inspect the build output.",
    checkout: "isolated",
  };
  expect(v.parse(ChildLaunchSchema, original)).toMatchObject(original);
  const selected = v.parse(ChildLaunchSchema, {
    ...original,
    instanceId: "codex",
    model: { id: "gpt-test", options: { reasoning: "high", temperature: 0.2 } },
    requestedMode: "edits",
  });
  expect(v.parse(ChildLaunchSchema, selected)).toEqual(selected);
  expect(
    v.safeParse(ChildLaunchSchema, { ...selected, model: { id: "", options: {} } }).success,
  ).toBe(false);
});

test("waiting children keep the exact approval request and round identities", () => {
  const status = v.parse(ChildStatusSchema, {
    taskId: "task",
    childCommandId: "child-command",
    threadId: "child-thread",
    state: { kind: "waitingApproval", roundId: "child-round", requestId: "native-request" },
  });
  expect(v.parse(ChildStatusSchema, status)).toEqual(status);
  expect(
    v.safeParse(ChildStatusSchema, {
      ...status,
      state: { kind: "waitingApproval", roundId: "child-round" },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(ChildStatusSchema, { ...status, approval: { requestId: "wrong-place" } }).success,
  ).toBe(false);
});

test("durable child records freeze effective settings and the result transfer identity", () => {
  const record = v.parse(DelegatedChildRecordSchema, {
    taskId: "task",
    parentThreadId: "parent",
    parentRoundId: "parent-round",
    childCommandId: "child-command",
    childThreadId: "child",
    childRoundId: "child-round",
    instanceId: "codex",
    model: { id: "gpt-test", options: { reasoning: "high" } },
    requestedMode: "edits",
    effectiveMode: "ask",
    returnTransferId: "return-transfer",
    state: { kind: "working" },
  });
  expect(v.parse(DelegatedChildRecordSchema, record)).toEqual(record);
  expect(v.safeParse(DelegatedChildRecordSchema, { ...record, returnTransferId: "" }).success).toBe(
    false,
  );
});
