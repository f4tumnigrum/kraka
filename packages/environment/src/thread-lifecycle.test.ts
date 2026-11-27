import { expect, test } from "bun:test";
import * as v from "valibot";
import { ThreadLifecycleSchema } from "@kraka/protocol";
import { changeThreadLifecycle, settleThread } from "./thread-lifecycle";
const pinned = v.parse(ThreadLifecycleSchema, {
  archivedAt: null,
  state: { kind: "active", pinnedAt: 12, pinPosition: "1", manualPosition: "2", snoozedUntil: 20 },
});
test("pinned threads survive idle and merged PR settlement, while manual settlement clears active ordering", () => {
  expect(settleThread(pinned, "idle", 100)).toBe(pinned);
  expect(settleThread(pinned, "merged", 100)).toBe(pinned);
  expect(changeThreadLifecycle(pinned, { kind: "settle" }, 100, false)).toEqual({
    archivedAt: null,
    state: { kind: "settled", reason: "manual", at: 100 },
  });
  const unpinned = changeThreadLifecycle(pinned, { kind: "unpin" }, 100, false);
  if (!unpinned) throw new Error("Expected active thread");
  expect(settleThread(unpinned, "idle", 101).state.kind).toBe("settled");
});
