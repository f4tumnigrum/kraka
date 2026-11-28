import { Database } from "bun:sqlite";
import {
  EnvironmentIdSchema,
  PrincipalIdSchema,
  HistoryPageSchema,
  type HistoryRow,
} from "@kraka/protocol";
import { ThreadJournal } from "./thread-journal";
import { planListPass, earlierSettledPage } from "./list-pass";
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

test("the list keeps every cutoff tie and visible ancestor and excludes an unreadable child's facts", () => {
  const db = new Database(":memory:");
  try {
    for (const table of ["threads", "rounds", "messages"])
      db.exec("CREATE TABLE " + table + "(data TEXT)");
    const journal = ThreadJournal.open(db, v.parse(EnvironmentIdSchema, "env"));
    const rows: HistoryRow[] = [];
    function thread(id: string, at: number | null, parent?: string) {
      rows.push(
        v.parse(HistoryPageSchema.entries.rows.item, {
          objectType: "thread",
          value: {
            id,
            title: id,
            worktreeId: null,
            projectId: "project",
            version: "1",
            lineage: parent ? { kind: "child", parentThreadId: parent } : { kind: "root" },
            ...(at === null
              ? {}
              : {
                  lifecycle: { archivedAt: null, state: { kind: "settled", at, reason: "manual" } },
                }),
          },
        }),
      );
    }
    for (let i = 0; i < 24; i++) thread("recent-" + i, i + 10);
    thread("tie-a", 4);
    thread("tie-b", 4);
    thread("older-parent", 3);
    thread("older", 2);
    thread("active", null, "older-parent");
    thread("private", null, "active");
    db.transaction(() => journal.record(rows))();
    const actor = v.parse(PrincipalIdSchema, "owner"),
      scope = { kind: "list" as const, projectId: null };
    const readView = journal.readList(
      scope,
      "x",
      actor,
      (id) => id !== "private",
      () => false,
    );
    const args = { actor, scope, knownThreads: [], readView };
    const plan = planListPass({ ...args, base: null });
    if (plan.kind !== "pass") throw Error("Missing list");
    const ids = plan.members.map((m) => String(m.key.id));
    expect(ids).toHaveLength(28);
    for (const id of ["tie-a", "tie-b", "older-parent", "active"]) expect(ids).toContain(id);
    expect(JSON.stringify(plan.changes)).not.toContain("private");
    expect(plan.changes.find((c) => c.kind === "list.counts")).toMatchObject({
      counts: { settled: 28, active: 1 },
    });
    expect(earlierSettledPage(readView, null)?.threads.map((t) => String(t.threadId))).toEqual([
      "older",
    ]);
    expect(planListPass({ ...args, base: { ...plan.through, shapeVersion: 1 } })).toEqual({
      kind: "reset",
      reason: "shapeChanged",
    });
  } finally {
    db.close(true);
  }
});
