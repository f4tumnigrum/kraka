import { test, expect } from "bun:test";
import * as v from "valibot";
import { transitionRound } from "./round";
import {
  AttemptIdSchema,
  RoundAttemptSchema,
  REQUEST_METHODS,
  hasMethodPermissions,
  CaptureIdSchema,
  CheckpointCaptureSchema,
  CommandIdSchema,
  GitObjectIdSchema,
  NativeItemIdSchema,
  ObjectVersionSchema,
  RollbackProgressSchema,
  RollbackTargetSchema,
  RoundIdSchema,
  ThreadIdSchema,
  WorktreeIdSchema,
  checkpointSummary,
} from "@kraka/protocol";
import {
  attributeFile,
  beginCapture,
  captureWorkspace,
  checkpointRef,
  transitionCapture,
  beginRollback,
  transitionRollback,
  type CaptureEvent,
  type CaptureState,
  type RollbackEvent,
} from "./checkpoints";
const key = {
  id: v.parse(CaptureIdSchema, "first capture"),
  attemptId: v.parse(AttemptIdSchema, "first attempt"),
  roundId: v.parse(RoundIdSchema, "first round"),
  threadId: v.parse(ThreadIdSchema, "thread-a"),
  worktreeId: v.parse(WorktreeIdSchema, "w"),
};
const oid = (char: string) => v.parse(GitObjectIdSchema, char.repeat(40));
const point = (k: typeof key, side: "before" | "after", char: string) => ({
  ref: checkpointRef(k, side),
  commit: oid(char),
  tree: oid(char),
});
const version = v.parse(ObjectVersionSchema, "3");
function step(state: CaptureState, event: CaptureEvent): CaptureState {
  const r = transitionCapture(state, event);
  if (r.kind === "rejected") throw new Error(r.reason);
  return r.value;
}

test("uses the newly published baseline for each attempt, including edits made between rounds", () => {
  const next = {
    ...key,
    id: v.parse(CaptureIdSchema, "next capture"),
    attemptId: v.parse(AttemptIdSchema, "next attempt"),
    roundId: v.parse(RoundIdSchema, "next round"),
  };
  const k = beginCapture(next);
  expect(captureWorkspace(k)).toMatchObject({
    ref: checkpointRef(next, "before"),
    compareFrom: null,
  });
  expect(captureWorkspace(k)?.privateIndexPath).not.toEqual(
    captureWorkspace(beginCapture(key))?.privateIndexPath,
  );
  expect(transitionCapture(k, { ...next, kind: "rootEnded" }).kind).toBe("rejected");
  expect(
    transitionCapture(k, { ...next, kind: "baselinePublished", point: point(key, "after", "1") })
      .kind,
  ).toBe("rejected");
  const baseline = {
    ...next,
    kind: "baselinePublished" as const,
    point: point(next, "before", "2"),
  };
  const working = step(k, baseline);
  expect(step(working, baseline)).toBe(working);
  const after = step(working, { ...next, kind: "rootEnded" });
  const publication = {
    ...next,
    kind: "endPublished" as const,
    point: point(next, "after", "3"),
    version,
    comparison: { kind: "compared" as const, files: [] },
  };
  const recorded = step(after, publication);
  expect(recorded).toMatchObject({
    kind: "settled",
    capture: {
      id: next.id,
      roundId: next.roundId,
      attemptId: next.attemptId,
      result: { comparison: { before: oid("2"), after: oid("3") } },
    },
  });
  // A restart after publishing the end ref but before recording it sees the same point and capture.
  expect(step(after, publication)).toEqual(recorded);
  expect(step(recorded, publication)).toBe(recorded);
});

test("attributes each path from matching evidence and leaves overlapping or unseen writers unknown", () => {
  const writer = { ...key, itemId: v.parse(NativeItemIdSchema, "tool-1"), path: "owned" };
  const other = { ...writer, threadId: v.parse(ThreadIdSchema, "thread-b") };
  expect(attributeFile("owned", [writer, { ...other, path: "other" }], "complete")).toMatchObject({
    kind: "observed",
    threadId: key.threadId,
    attemptId: key.attemptId,
  });
  expect(attributeFile("owned", [writer, other], "complete")).toEqual({
    kind: "unknown",
    reason: "overlap",
  });
  expect(attributeFile("owned", [writer], "sharedWriter")).toEqual({
    kind: "unknown",
    reason: "sharedWriter",
  });
  expect(attributeFile("unobserved", [writer], "complete")).toEqual({
    kind: "unknown",
    reason: "noObservation",
  });
});

test("distinguishes an uncomputed summary, a proven empty comparison, missing capture and capture failure", () => {
  const waiting = step(
    step(beginCapture(key), {
      ...key,
      kind: "baselinePublished",
      point: point(key, "before", "1"),
    }),
    { ...key, kind: "rootEnded" },
  );
  const file = {
    path: "edited",
    previousPath: null,
    change: "modified" as const,
    owner: attributeFile("edited", [], "sharedWriter"),
  };
  for (const [comparison, expected] of [
    [{ kind: "compared", files: [] }, { kind: "empty" }],
    [
      { kind: "compared", files: [file] },
      { kind: "changed", fileCount: 1 },
    ],
    [
      { kind: "unknown", reason: "comparison interrupted" },
      { kind: "unknown", reason: "comparison interrupted" },
    ],
  ] as const) {
    const settled = step(waiting, {
      ...key,
      kind: "endPublished",
      point: point(key, "after", "2"),
      version,
      comparison,
    });
    if (settled.kind !== "settled") throw new Error("Expected settlement");
    expect(checkpointSummary(v.parse(CheckpointCaptureSchema, settled.capture).result)).toEqual(
      expected,
    );
  }
  for (const kind of ["missing", "error"] as const) {
    const result = step(waiting, {
      ...key,
      kind,
      boundary: "after",
      reason: "directory unavailable",
      version,
    });
    expect(result).toMatchObject({
      kind: "settled",
      baseline: point(key, "before", "1"),
      capture: { result: { kind, boundary: "after" } },
    });
  }
  expect(checkpointSummary({ kind: "ready", worktreeId: key.worktreeId }).kind).toBe("unknown");
});

test("preserves successful dialogue rollback when file restore fails, retries or has an uncertain outcome", () => {
  const id = v.parse(CommandIdSchema, "rollback");
  const target = v.parse(RollbackTargetSchema, {
    threadId: key.threadId,
    worktreeId: key.worktreeId,
    roundId: key.roundId,
    attemptId: key.attemptId,
    captureId: key.id,
    boundary: "before",
  });
  const capture = v.parse(CheckpointCaptureSchema, {
    id: key.id,
    roundId: key.roundId,
    attemptId: key.attemptId,
    version,
    result: {
      kind: "ready",
      worktreeId: key.worktreeId,
      comparison: {
        before: oid("1"),
        after: oid("2"),
        summary: { kind: "unknown", reason: "summary pending" },
      },
    },
  });
  let state = beginRollback(id, target, "both");
  const move = (event: RollbackEvent) => {
    const result = transitionRollback(state, event);
    if (result.kind === "rejected") throw new Error(result.reason);
    state = result.value;
  };
  const dialogue = { commandId: id, part: "dialogue" as const, execution: 1 };
  const files = { commandId: id, part: "files" as const, execution: 1 };
  expect(
    transitionRollback(state, { ...files, kind: "claim", capture, exclusive: false }),
  ).toMatchObject({
    kind: "ok",
    value: { files: { kind: "failed", reason: "sharedWorkspace" }, dialogue: { kind: "pending" } },
  });
  move({ ...dialogue, kind: "claim" });
  move({ ...dialogue, kind: "succeeded" });
  move({ ...files, capture, exclusive: true, kind: "claim" });
  move({ ...files, kind: "failed", reason: "busy", retryable: true });
  expect(v.parse(RollbackProgressSchema, state)).toMatchObject({
    dialogue: { kind: "succeeded" },
    files: { kind: "failed", reason: "busy" },
  });
  expect(transitionRollback(state, { ...dialogue, kind: "retry" }).kind).toBe("rejected");
  move({ ...files, kind: "retry" });
  move({ ...files, capture, exclusive: true, kind: "claim", execution: 2 });
  expect(transitionRollback(state, { ...files, kind: "succeeded" }).kind).toBe("rejected");
  move({ ...files, kind: "unknown", execution: 2, reason: "process exited" });
  expect(transitionRollback(state, { ...files, kind: "retry", execution: 2 }).kind).toBe(
    "rejected",
  );
  move({ ...files, kind: "verified", execution: 2, finding: "applied" });
  expect(state).toMatchObject({
    dialogue: { kind: "succeeded", execution: 1 },
    files: { kind: "succeeded", execution: 2 },
  });
  expect(
    transitionRollback(beginRollback(id, target, "files"), { ...dialogue, kind: "claim" }).kind,
  ).toBe("rejected");
});

test("a newly settled capture can finalize its matching round and joint rollback requires both object rights", () => {
  const base = step(beginCapture(key), {
    ...key,
    kind: "baselinePublished",
    point: point(key, "before", "1"),
  });
  const ended = step(base, { ...key, kind: "rootEnded" });
  const record = step(ended, {
    ...key,
    kind: "error",
    boundary: "after",
    reason: "unreadable",
    version,
  });
  if (record.kind !== "settled") throw new Error("Expected capture settlement");
  const attempt = v.parse(RoundAttemptSchema, {
    attemptId: key.attemptId,
    deliveryId: "delivery",
    phase: {
      kind: "closing",
      root: { sessionId: "native", id: "root", beganAt: 1 },
      receipt: null,
      endedAt: 2,
      captureId: key.id,
    },
  });
  const report = {
    kind: "captureSettled" as const,
    attemptId: attempt.attemptId,
    deliveryId: attempt.deliveryId,
    capture: record.capture,
  };
  expect(transitionRound(attempt, report)).toMatchObject({
    kind: "ok",
    value: { kind: "finished", captureId: key.id },
  });
  const method = REQUEST_METHODS.rollbackBoth;
  expect(hasMethodPermissions(method, new Set(["thread.send"]))).toBe(false);
  expect(hasMethodPermissions(method, new Set(["workspace.change"]))).toBe(false);
  expect(hasMethodPermissions(method, new Set(["thread.send", "workspace.change"]))).toBe(true);
  expect(hasMethodPermissions(REQUEST_METHODS.restoreFiles, new Set(["workspace.change"]))).toBe(
    true,
  );
});
