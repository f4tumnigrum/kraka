import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ObjectVersionSchema,
  TextReturnedEventSchema,
  SyncCursorSchema,
  WorkRelationshipSchema,
  HistoryCoverageSchema,
} from "@kraka/protocol";
import { fixtureSession } from "../../../tools/fixtures/flow-session";
import { ThreadInstallation } from "../src/thread-installation";
import {
  emptyThreadCache,
  relationshipCoverage,
  scopeKey,
  type ThreadCacheStore,
} from "../src/thread-pass";

const head = (through: string) =>
  v.parse(SyncCursorSchema, {
    environmentId: "studio",
    databaseGeneration: "db",
    visibilityGeneration: "owner",
    scope: { kind: "thread", threadId: "t" },
    shapeVersion: 1,
    through,
  });
const thread = (title: string, version = "1") => ({
  kind: "object.replace",
  object: {
    objectType: "thread",
    value: { id: "t", projectId: "p", worktreeId: null, title, lineage: { kind: "root" }, version },
  },
});
const key = { id: "t", objectType: "thread" };
function fixture() {
  let cache = emptyThreadCache();
  const acks: string[] = [];
  const store: ThreadCacheStore = {
    async transact(edit) {
      const { next, result } = edit(cache);
      cache = next;
      return result;
    },
  };
  return {
    read: () => cache,
    store,
    acks,
    open(
      after: string | null,
      extras: { staged?: () => Promise<void>; store?: ThreadCacheStore; recheck?: string[] } = {},
    ) {
      const session = fixtureSession("desktop", "epoch");
      const req = session.request("subscription.openThread", {
        threadId: "t",
        streamId: 1,
        subscriptionId: "s",
        after: after === null ? null : head(after),
        knownWindow: [],
        recheckTodos: extras.recheck ?? [],
      });
      if (req.method !== "subscription.openThread") throw Error("Expected open");
      const sub = new ThreadInstallation(req, {
        store: extras.store ?? store,
        ack: (a) => acks.push(a.method),
        ...(extras.staged ? { pageStaged: extras.staged } : {}),
      });
      const frame = (message: unknown, streamId = 0) =>
        sub.frame({ epoch: "epoch", streamId, message });
      const receipt = () =>
        frame({
          kind: "accepted",
          commandId: req.commandId,
          result: { kind: "subscriptionOpened", subscriptionId: "s", streamId: 1 },
        });
      function pass(through: string, changes: unknown[], passId = "p") {
        const cursor = head(through);
        frame({
          kind: "subscription.begin",
          subscriptionId: "s",
          passId,
          base: after === null ? null : head(after),
          through: cursor,
          mode: after === null ? "replace" : "merge",
        });
        const page = (cs = changes) =>
          frame(
            {
              kind: "subscription.page",
              subscriptionId: "s",
              passId,
              through: cursor,
              pageNumber: 0,
              pageCount: 1,
              changes: cs,
            },
            1,
          );
        const seal = () =>
          frame({ kind: "subscription.seal", subscriptionId: "s", passId, cursor, pages: 1 });
        return { page, seal };
      }
      return { sub, receipt, pass };
    },
  };
}
test("identical pages are idempotent and early data waits for the receipt and staged write", async () => {
  const f = fixture(),
    hold = Promise.withResolvers<void>(),
    s = f.open(null, { staged: () => hold.promise });
  const p = s.pass("0", [thread("zero"), { kind: "window.enter", key }]);
  p.page();
  p.page();
  p.seal();
  expect(f.acks).toEqual([]);
  s.receipt();
  expect(f.read().scopes).toEqual({});
  hold.resolve();
  await s.sub.settled;
  expect(f.read().scopes[scopeKey(head("0"))]?.cursor).toEqual(head("0"));
  expect(f.acks).toEqual(["subscription.pageSaved", "subscription.installed"]);
});
test("conflicting repeats, unknown changes and missing todo reconciliation preserve the old cursor", async () => {
  const f = fixture(),
    initial = f.open(null);
  initial.receipt();
  const a = initial.pass("1", [thread("first")]);
  a.page();
  a.seal();
  await initial.sub.settled;
  for (const issue of ["peer", "unknown", "todo", "missing"]) {
    const s = f.open("1", issue === "todo" ? { recheck: ["r"] } : {});
    s.receipt();
    const p = s.pass("2", [thread("next", "2")]);
    if (issue !== "missing") p.page(issue === "unknown" ? [{ kind: "future" }] : undefined);
    if (issue === "peer") p.page([thread("other", "2")]);
    p.seal();
    await s.sub.settled;
    expect(s.sub.state.status).toBe("gap");
    expect(f.read().scopes[scopeKey(head("1"))]?.cursor).toEqual(head("1"));
  }
  expect(f.acks.filter((a) => a === "subscription.installed")).toHaveLength(1);
});
test("departures retain the object, deletions keep a tombstone, and an old writer loses the base comparison", async () => {
  const f = fixture();
  async function apply(after: string | null, h: string, cs: unknown[]) {
    const s = f.open(after);
    s.receipt();
    const p = s.pass(h, cs);
    p.page();
    p.seal();
    await s.sub.settled;
    return s;
  }
  await apply(null, "1", [thread("old"), { kind: "window.enter", key }]);
  await apply("1", "2", [{ kind: "window.leave", key }]);
  expect(String(f.read().rows['["thread","t"]']?.row?.value.id)).toBe("t");
  expect(f.read().scopes[scopeKey(head("1"))]?.members).toEqual({});
  const late = await apply("1", "5", [thread("late", "5")]);
  expect(late.sub.state.status).toBe("gap");
  await apply("2", "3", [{ kind: "object.remove", key, version: "10" }]);
  await apply("3", "4", [thread("stale", "9")]);
  expect(f.read().rows['["thread","t"]']).toEqual({
    row: null,
    version: v.parse(ObjectVersionSchema, "10"),
  });
});
test("one returned text retains its input identity and coverage when resumed or interrupted", async () => {
  const f = fixture(),
    ret = {
      kind: "handoff.textReturned",
      version: "1",
      result: {
        kind: "textReturned",
        transferId: "transfer",
        source: { environmentId: "studio", threadId: "child", roundId: "r" },
        target: { environmentId: "studio", threadId: "t" },
        text: "saved return",
        history: { coverage: "complete", omittedItems: 3, missingSources: [] },
        input: { messageId: "m", roundId: "r2", attemptId: "a", deliveryId: "d" },
      },
    };
  for (const [after, to] of [
    [null, "1"],
    ["1", "2"],
  ] as const) {
    const s = f.open(after);
    s.receipt();
    const p = s.pass(to, [ret]);
    p.page();
    p.seal();
    await s.sub.settled;
  }
  expect(Object.values(f.read().returns)).toEqual([v.parse(TextReturnedEventSchema, ret)]);
  for (const coverage of [
    ret.result.history,
    {
      coverage: "partial",
      omittedItems: 2,
      missingSources: [{ kind: "missingThread", environmentId: "studio", threadId: "missing" }],
    },
    undefined,
  ]) {
    const relation = v.parse(WorkRelationshipSchema, {
      kind: "providerHandoff",
      threadId: "t",
      sourceSessionId: "s",
      targetSessionId: null,
      messageIds: [],
      ...(coverage ? { history: coverage } : {}),
    });
    if (relation.kind !== "providerHandoff") throw Error("Expected handoff");
    expect(relationshipCoverage(relation)).toEqual(
      v.parse(HistoryCoverageSchema, coverage ?? { coverage: "unknown", omittedItems: null }),
    );
  }
  const before = f.read();
  const s = f.open("2", {
    store: {
      async transact(edit) {
        edit(before);
        throw Error("Interrupted before commit");
      },
    },
  });
  s.receipt();
  const p = s.pass("3", [thread("new")]);
  p.page();
  p.seal();
  await s.sub.settled;
  expect(f.read()).toEqual(before);
  expect(f.acks.at(-1)).toBe("subscription.gap");
});
