import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AttentionFactsSchema,
  SubscriptionPageSchema,
  SyncCursorSchema,
  subscriptionWirePage,
  SyncPositionSchema,
  AttentionOccurrenceSchema,
  AttentionReadSchema,
  ReminderRecordSchema,
  AttentionHintSchema,
  DeviceIdSchema,
  REQUEST_METHODS,
} from "@kraka/protocol";
import {
  currentReminders,
  installThreadPass,
  installedList,
  emptyThreadCache,
  type ThreadCacheStore,
  reminderForOccurrence,
  claimReminder,
  interpretAttention,
  reminderKeyId,
  updateReminder,
} from "../src";

const scope = { ownerId: "owner", environmentId: "env", databaseGeneration: "era" };
const root = { threadId: "root", readThrough: "0", grouping: "ordinary", requests: [], rounds: [] };
function request(id: string, kind: "approval" | "question" | "secret", openedAt: string) {
  const body =
    kind === "approval"
      ? { kind, tool: "command", choices: [] }
      : kind === "question"
        ? { kind, questions: [{ key: "q", text: "Which?", choices: [] }] }
        : { kind, slot: "token" };
  return {
    openedAt,
    request: {
      id,
      body,
      state: {
        kind: "open",
        route: {
          kind: "live",
          subject: kind,
          sessionId: "s",
          requestId: `native-${id}`,
          fallback: { kind: "expire" },
        },
      },
    },
  };
}
function facts(overrides: Record<string, unknown> = {}, descendants: unknown[] = []) {
  return v.parse(AttentionFactsSchema, {
    ...scope,
    through: "100",
    root: { ...root, ...overrides },
    descendants,
  });
}
const rootTurn = { sessionId: "s", id: "native", beganAt: 1 };
function activity(phase: unknown, review: unknown = null, quota: unknown = null, attemptId = "a") {
  return {
    changedAt: "10",
    round: { id: "round", attempt: { attemptId, deliveryId: "d", phase } },
    quota,
    review,
  };
}
test("keeps every open request and chooses the earliest highest-priority cause across the visible family", () => {
  const questions = [request("later", "question", "11"), request("first", "secret", "2")];
  const child = { ...root, threadId: "child", requests: [request("permit", "approval", "12")] };
  const family = facts({ requests: questions }, [child, child]);
  const reading = interpretAttention(family);
  expect(
    reading.open.map((c) =>
      c.key.object.kind === "request" ? String(c.key.object.requestId) : "unexpected round",
    ),
  ).toEqual(["permit", "first", "later"]);
  expect(reading.first).toMatchObject({
    kind: "approval",
    priority: 0,
    needsHuman: true,
    key: { threadId: "child" },
  });
  expect(interpretAttention(facts({ requests: questions.slice().reverse() }, [child]))).toEqual(
    reading,
  );
  expect(reading.open[0]?.key).toEqual(interpretAttention(facts(child)).open[0]?.key);
});

test("keeps focus private and claims each original key at most once per device, including after restart", () => {
  const reading = interpretAttention(
    facts({ requests: [request("r", "approval", "1"), request("r2", "approval", "1")] }),
  );
  const first = reading.open[0]?.reminder,
    second = reading.open[1]?.reminder;
  if (!first || !second) throw new Error("Missing a request");
  const alpha = v.parse(DeviceIdSchema, "a"),
    beta = v.parse(DeviceIdSchema, "b");
  const visible = first.key;
  const quiet = claimReminder(alpha, first, visible, null),
    loud = claimReminder(beta, first, null, null);
  expect(quiet.present).toBe(false);
  expect(quiet.record.state).toBe("suppressed");
  expect(loud.present).toBe(true);
  for (const record of [
    loud.record,
    updateReminder(loud.record, "receiptLost"),
    updateReminder(loud.record, "confirmed"),
    updateReminder(loud.record, "closed"),
  ]) {
    expect(claimReminder(beta, first, null, record)).toEqual({ present: false, record });
  }
  expect(claimReminder(alpha, first, null, quiet.record).present).toBe(false);
  expect(claimReminder(beta, second, null, null).present).toBe(true);
  expect(reminderKeyId(first.key)).not.toBe(reminderKeyId(second.key));
  expect(() => claimReminder(beta, second, null, loud.record)).toThrow();
  expect(v.safeParse(AttentionHintSchema, { ...first, body: "private" }).success).toBe(false);
  expect(v.safeParse(AttentionFactsSchema, { ...facts(), visibleThreadId: "root" }).success).toBe(
    false,
  );
  expect(REQUEST_METHODS.readAttention.permission).toBe("thread.view");
});

test("reads the existing round phases and preserves the attempt in completion and failure reminders", () => {
  const end = { root: rootTurn, receipt: null, endedAt: 2 };
  const cases = [
    [activity({ kind: "filed", gate: "eligible" }), "preparation"],
    [activity({ kind: "armed" }), "preparation"],
    [activity({ kind: "handed", wroteAt: 1 }), "wait"],
    [activity({ kind: "uncertain", next: "inspectInput" }), "unknown"],
    [activity({ kind: "working", root: rootTurn, receipt: null }), "work"],
    [
      activity({ kind: "working", root: rootTurn, receipt: null }, null, { resetAt: null }),
      "quota",
    ],
    [activity({ kind: "closing", ...end, captureId: "capture" }), "work"],
    [activity({ kind: "endedEarly", ...end, reason: "failed" }), "failure"],
    [activity({ kind: "endedEarly", ...end, reason: "stopped" }), "ready"],
    [activity({ kind: "endedEarly", ...end, reason: "superseded" }), "ready"],
    [activity({ kind: "endedEarly", ...end, reason: "unknown" }), "unknown"],
    [
      activity(
        { kind: "finished", ...end, captureId: "capture" },
        { kind: "plan", deferredAtEnd: false },
      ),
      "plan",
    ],
    [
      activity(
        { kind: "finished", ...end, captureId: "capture" },
        { kind: "work", deferredAtEnd: false },
      ),
      "check",
    ],
    [
      activity(
        { kind: "finished", ...end, captureId: "capture" },
        { kind: "work", deferredAtEnd: true },
      ),
      "ready",
    ],
  ] as const;
  for (const [round, expected] of cases)
    expect(interpretAttention(facts({ rounds: [round] })).first.kind).toBe(expected);
  expect(
    interpretAttention(facts({ rounds: [activity({ kind: "filed", gate: "held" })] })).needsHuman,
  ).toBe(true);
  const failure = activity({ kind: "endedEarly", ...end, reason: "failed" });
  expect(interpretAttention(facts({ rounds: [failure], readThrough: "10" })).first).toMatchObject({
    kind: "ready",
    reminder: null,
  });
  const failed = interpretAttention(facts({ rounds: [failure] })).first;
  expect(failed.reminder).toMatchObject({
    kind: "roundFailed",
    key: { object: { kind: "round", roundId: "round", attemptId: "a" } },
  });
  expect(interpretAttention(facts()).first).toMatchObject({
    kind: "ready",
    needsHuman: false,
    key: null,
  });
});

test("keeps a closed original request out of the actionable list when its successor arrives", () => {
  const expired = request("old", "approval", "3");
  const reading = interpretAttention(
    facts({
      requests: [
        {
          ...expired,
          request: { ...expired.request, state: { kind: "expired", reason: "sessionLost" } },
        },
        request("new", "question", "5"),
      ],
    }),
  );
  expect(
    reading.open.map((c) =>
      c.key.object.kind === "request" ? String(c.key.object.requestId) : "unexpected round",
    ),
  ).toEqual(["new"]);
});

test("recovery and clicking an old reminder retain the original object after it closes", () => {
  const source = request("original", "question", "3");
  const retired = v.parse(AttentionOccurrenceSchema, {
    kind: "requestOpened",
    threadId: "root",
    ...source,
    request: { ...source.request, state: { kind: "expired", reason: "sessionLost" } },
  });
  const installed = facts();
  const { databaseGeneration } = installed;
  const hint = reminderForOccurrence(installed, retired);
  expect(hint).toEqual(interpretAttention(facts({ requests: [source] })).open[0]?.reminder ?? null);
  if (!hint) throw new Error("Expected original request hint");
  expect(
    v.parse(AttentionReadSchema, {
      threadId: hint.key.threadId,
      selection: { kind: "object", databaseGeneration, object: hint.key.object },
    }),
  ).toMatchObject({ selection: { object: { requestId: "original" } } });
  const device = v.parse(DeviceIdSchema, "d");
  const claimed = claimReminder(device, hint, null, null).record;
  const restored = v.parse(ReminderRecordSchema, JSON.parse(JSON.stringify(claimed)));
  expect(claimReminder(device, hint, null, restored).present).toBe(false);
});

test("enabling reminders includes older open requests while keeping prior completed attempts silent", () => {
  const reviewed = activity(
    { kind: "finished", root: rootTurn, receipt: null, endedAt: 2, captureId: "c" },
    { kind: "work", deferredAtEnd: false },
  );
  const reading = interpretAttention(
    facts({ rounds: [reviewed], requests: [request("answered-later", "question", "2")] }),
  );
  expect(currentReminders(reading, v.parse(SyncPositionSchema, "10")).map((h) => h.kind)).toEqual([
    "question",
  ]);
  expect(currentReminders(reading, v.parse(SyncPositionSchema, "9")).map((h) => h.kind)).toEqual([
    "question",
    "roundCompleted",
  ]);
});

test("list defaults round-trip raw facts and a missing fact set cannot certify a ready row", async () => {
  const through = v.parse(SyncCursorSchema, {
    environmentId: "env",
    databaseGeneration: "era",
    visibilityGeneration: "v",
    scope: { kind: "list", projectId: null },
    shapeVersion: 2,
    through: "100",
  });
  const open = { kind: "window.enter", key: { objectType: "thread", id: "root" } };
  const summary = {
    kind: "thread.summary",
    summary: {
      threadId: "root",
      projectId: "project",
      parentThreadId: null,
      version: "9",
      title: "Root",
      createdAt: 22,
      lastActivityAt: 22,
      lifecycle: {
        archivedAt: null,
        state: {
          kind: "active",
          pinnedAt: null,
          pinPosition: null,
          manualPosition: null,
          snoozedUntil: null,
        },
      },
      openTodos: 0,
      activeRounds: 0,
    },
  };
  const page = v.parse(SubscriptionPageSchema, {
    kind: "subscription.page",
    subscriptionId: "sub",
    passId: "pass",
    through,
    pageNumber: 0,
    pageCount: 1,
    changes: [
      summary,
      open,
      {
        kind: "list.counts",
        counts: { active: 1, settled: 0, archived: 0, pinned: 0, snoozed: 0 },
      },
    ],
  });
  const begin = {
    kind: "subscription.begin" as const,
    mode: "replace" as const,
    through,
    base: null,
    subscriptionId: page.subscriptionId,
    passId: page.passId,
  };
  let saved = emptyThreadCache();
  const store: ThreadCacheStore = {
    async transact(edit) {
      const { next, result } = edit(saved);
      saved = next;
      return result;
    },
  };
  const install = () =>
    installThreadPass(store, null, { begin, recheck: new Set(), pages: [page] });
  await expect(install()).rejects.toThrow("Incomplete list facts");
  expect(saved).toEqual(emptyThreadCache());
  const empty = facts({ readThrough: null });
  page.changes.push({ kind: "attention.facts", facts: empty });
  const sparse = JSON.parse(JSON.stringify(subscriptionWirePage(page)));
  expect(sparse.changes[0].summary.lifecycle).toEqual({});
  expect(sparse.changes[1].key).toEqual({ id: "root" });
  expect(sparse.changes[3].facts.root).toEqual({ threadId: "root" });
  expect(v.parse(SubscriptionPageSchema, sparse)).toEqual(page);
  expect(
    v.safeParse(SubscriptionPageSchema, { ...sparse, through: { ...through, shapeVersion: 1 } })
      .success,
  ).toBe(false);
  for (const field of ["threadId", "projectId", "lifecycle", "version", "createdAt"]) {
    const invalid = structuredClone(sparse);
    delete invalid.changes[0].summary[field];
    expect(v.safeParse(SubscriptionPageSchema, invalid).success).toBe(false);
  }
  expect(await install()).toBe("installed");
  expect(installedList(saved, { status: "current", installed: through })?.rows[0]?.state).toBe(
    "ready",
  );
  const populated = v.parse(SubscriptionPageSchema, {
    ...page,
    changes: [
      {
        ...summary,
        summary: {
          ...summary.summary,
          lastActivityAt: 50,
          lifecycle: { archivedAt: 22, state: { kind: "settled", at: 21, reason: "manual" } },
        },
      },
      {
        kind: "attention.facts",
        facts: facts(
          {
            grouping: "archived",
            requests: [request("r", "approval", "11")],
            rounds: [
              activity(
                {
                  kind: "finished",
                  root: rootTurn,
                  receipt: { sessionId: "s", itemId: "receipt" },
                  endedAt: 2,
                  captureId: "c",
                  endTimeEvidence: {
                    source: "executorReported",
                    executorEndedAt: 2,
                    environmentObservedAt: null,
                  },
                },
                { kind: "plan", deferredAtEnd: true },
                { resetAt: 0 },
              ),
            ],
          },
          [{ ...root, threadId: "child" }],
        ),
      },
    ],
  });
  expect(
    v.parse(SubscriptionPageSchema, JSON.parse(JSON.stringify(subscriptionWirePage(populated)))),
  ).toEqual(populated);
});
