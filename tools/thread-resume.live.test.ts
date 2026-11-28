import { expect, onTestFinished, test } from "bun:test";
import { join } from "node:path";
import { writeFileSync, unlinkSync } from "node:fs";
import * as v from "valibot";
import {
  ToolActivityHistoryItemSchema,
  SubscriptionPageSchema,
  ControlMessageSchema,
  ThreadIdSchema,
  type SyncCursor,
} from "@kraka/protocol";
import {
  scopeKey,
  cachedHistory,
  installHistoryPage,
} from "../packages/client-runtime/src/thread-pass";
import { threadFixture, turnRows, until } from "./fixtures/thread-resume";
import { parseScenario } from "./fixtures/scenario";
const scenario = parseScenario(
  await Bun.file(
    join(import.meta.dir, "../fixtures/scenarios/reconnect-only-replaces-changed-objects.json"),
  ).json(),
);
const input = scenario.inputs
  .flatMap((i) => (i.event.kind === "commands" ? i.event.requests : []))
  .find((r) => r.method === "input.send");
if (input?.method !== "input.send") throw Error("Fixture has no input");
const payload = input.payload;
type Connection = Awaited<ReturnType<typeof import("./fixtures/thread-resume").connectReplica>>;
function visible(c: Connection) {
  const cache = c.cache.read();
  return Object.values(cache.rows).flatMap((r) => r.row ?? []);
}
const op = async (c: Connection, t: typeof payload.threadId, base: SyncCursor | null = null) => {
  const o = await c.client.open(t, base);
  expect((await o.receipt).kind).toBe("accepted");
  return o;
};
function checkedPass(c: Connection, device: string, label: string, head: string) {
  const expected =
    scenario.clients
      .find((d) => d.deviceId === device)
      ?.expected.filter((e) => e.after === label)
      .flatMap((e) => e.messages) ?? [];
  const begin = c.messages.findIndex(
    (o) =>
      o.kind === "subscription.begin" &&
      v.parse(ControlMessageSchema, o.message).kind === "subscription.begin" &&
      (o.message as { through: SyncCursor }).through.through === head,
  );
  const actual = c.messages
    .slice(begin)
    .filter((m) =>
      ["subscription.begin", "subscription.page", "subscription.seal"].includes(m.kind),
    )
    .slice(0, 3)
    .map((m) => m.message);
  const logical = expected.filter(
    (m) =>
      "kind" in m &&
      ["subscription.begin", "subscription.page", "subscription.seal"].includes(m.kind),
  );
  function normalize(messages: unknown[]) {
    return messages.map((m) =>
      JSON.parse(
        JSON.stringify(m, (key, v) =>
          [
            "subscriptionId",
            "passId",
            "databaseGeneration",
            "visibilityGeneration",
            "environmentId",
          ].includes(key)
            ? "<" + key + ">"
            : v,
        ),
      ),
    );
  }
  expect(normalize(actual)).toEqual(normalize(logical));
}
test(
  "S-STATE-003 receipt versus install and the complete 1 to 4 reconnect trace",
  () =>
    threadFixture(async (f) => {
      await f.start();
      const reveal = Promise.withResolvers<void>();
      const d = await f.connect("desktop", { directoryDiff: false, timeline: false }),
        tablet = await f.connect("tablet", {
          directoryDiff: false,
          timeline: false,
          pageStaged: (page) => (page.through.through === "2" ? reveal.promise : undefined),
        });
      await op(d, f.threadId);
      const p = await d.at("1");
      await d.close();
      await op(tablet, f.threadId);
      await tablet.at("1");
      const sent = await tablet.client.rpc("input.send", payload);
      expect(sent).toMatchObject({
        kind: "accepted",
        result: { kind: "inputScheduled", messageId: "message-heading" },
      });
      expect(Object.values(tablet.cache.read().accepted)).toEqual([
        expect.objectContaining({ messageId: "message-heading", text: "Fix the heading." }),
      ]);
      reveal.resolve();
      await tablet.at("2");
      expect(tablet.cache.read().accepted).toEqual({});
      checkedPass(tablet, "tablet", "send-typo-note", "2");
      await f.control({ phase: { kind: "armed" } });
      await tablet.at("3");
      checkedPass(tablet, "tablet", "worker-claims-heading", "3");
      await f.control({ phase: { kind: "handed", wroteAt: 1000 } });
      await tablet.at("4");
      checkedPass(tablet, "tablet", "heading-written", "4");
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const back = await f.connect("desktop", {
        directoryDiff: false,
        timeline: false,
        pageStaged() {
          entered.resolve();
          return release.promise;
        },
      });
      const opened = await op(back, f.threadId, p);
      await entered.promise;
      expect(opened.sub.state.status).toBe("syncing");
      expect(visible(back).filter((r) => r.objectType === "message")).toHaveLength(0);
      release.resolve();
      await back.at("4");
      checkedPass(back, "desktop", "resume-from-one", "4");
      const cold = await f.connect("cold", { directoryDiff: false, timeline: false });
      await op(cold, f.threadId);
      await cold.at("4");
      expect(visible(back)).toEqual(visible(cold));
      expect(
        visible(back).filter(
          (r) => r.objectType === "message" && r.value.text === "Fix the heading.",
        ),
      ).toHaveLength(1);
    }),
  12000,
);
test(
  "S-STATE-012 resume installs the resolved request and its actual answer",
  () =>
    threadFixture(async (f) => {
      await f.start();
      const route = {
        kind: "message",
        subject: "question",
        nodeId: "node",
        questions: ["question"],
      };
      const todo = {
        id: "q",
        threadId: f.threadId,
        roundId: "round-1",
        body: { kind: "question", questions: [{ key: "title", text: "Title?", choices: [] }] },
        state: { kind: "open", route },
        version: "1",
      };
      await f.seed([...turnRows(f.threadId, 1), { objectType: "todoRequest", value: todo }]);
      const d = await f.connect("desktop");
      await op(d, f.threadId);
      const p = await d.at("2");
      await d.close();
      await f.seed([
        {
          objectType: "todoRequest",
          value: {
            ...todo,
            version: "2",
            state: {
              kind: "answered",
              route,
              answer: {
                authorId: "person",
                deviceId: "tablet",
                at: 1000,
                attemptId: "a",
                deliveryId: "d",
                content: { kind: "message", messageId: "answer" },
              },
              arrival: { kind: "viaMessage" },
              previousAttempts: [],
            },
          },
        },
        {
          objectType: "message",
          value: {
            id: "answer",
            threadId: f.threadId,
            roundId: "round-1",
            author: { kind: "person", id: "person" },
            text: "Use the short heading",
            references: [],
            attachments: [],
            version: "1",
          },
        },
      ]);
      const entered = Promise.withResolvers<void>(),
        hold = Promise.withResolvers<void>();
      const back = await f.connect("desktop", {
        pageStaged() {
          entered.resolve();
          return hold.promise;
        },
      });
      const sub = await op(back, f.threadId, p);
      await entered.promise;
      expect(sub.sub.state.status).toBe("syncing");
      hold.resolve();
      await back.at("3");
      expect(visible(back)).toContainEqual(
        expect.objectContaining({
          objectType: "message",
          value: expect.objectContaining({ id: "answer", text: "Use the short heading" }),
        }),
      );
      expect(visible(back).find((r) => r.objectType === "todoRequest")?.value).toMatchObject({
        state: { kind: "answered", answer: { content: { messageId: "answer" } } },
      });
    }),
  10000,
);
// Across 18 Windows CI runs the slowest case took 5.68 s, including 4.41 s pairing devices.
// An earlier run hit the 12 s deadline. Allow for runner delays and the writer's own 11 s publication deadline.
const expiredCursorTimeoutMs = process.platform === "win32" ? 30_000 : 12_000;
test(
  "S-STATE-013 expired cursor reopens once with a bounded window and independent history",
  async () => {
    let stage = "creating the fixture";
    let since = performance.now();
    function entering(name: string) {
      stage = name;
      since = performance.now();
    }
    onTestFinished(() => {
      if (stage)
        console.error(
          `S-STATE-013 interrupted while ${stage} (${Math.round(performance.now() - since)} ms in this step)`,
        );
    });
    try {
      await threadFixture(
        async (f) => {
          entering("seeding the initial thread");
          await f.start();
          entering("connecting the desktop");
          const d = await f.connect("desktop");
          entering("opening and installing position 1");
          await op(d, f.threadId);
          const p = await d.at("1");
          entering("disconnecting the desktop");
          await d.close();
          for (let i = 1; i <= 18; i++) {
            entering(`seeding turn ${i} of 18`);
            await f.seed(turnRows(f.threadId, i));
          }
          entering("advancing the retention floor");
          await f.control({ floor: "5" });
          entering("reconnecting the desktop");
          const back = await f.connect("desktop");
          entering("resetting and installing position 19");
          await op(back, f.threadId, p);
          const h = await back.at("19");
          expect(
            back.messages.filter((m) => m.kind === "subscription.reset").map((m) => m.message),
          ).toEqual([expect.objectContaining({ reason: "cursorExpired" })]);
          expect(Object.keys(back.cache.read().scopes[scopeKey(h)]!.members)).toHaveLength(21);
          entering("reading the older history page");
          const page = await back.client.history(h, null, () => true);
          expect(page.rows.filter((r) => r.objectType === "message")).toHaveLength(8);
          expect(page.olderAnchor).toBeNull();
          entering("committing and installing position 20");
          await f.seed(turnRows(f.threadId, 19));
          await back.at("20");
          expect(back.heads.filter((h) => h.through === "20")).toHaveLength(1);
          expect(
            cachedHistory(back.cache.read(), page.anchor, back.heads.at(-1)!)?.verifiedAt,
          ).toEqual(h);
        },
        undefined,
        entering,
      );
    } finally {
      stage = "";
    }
  },
  expiredCursorTimeoutMs,
);
test(
  "S-STATE-053 ancestor history preserves the ended activity over a late old page",
  () =>
    threadFixture(async (f) => {
      await f.start();
      await f.seed(turnRows(f.threadId, 1));
      const item = {
        kind: "toolActivity",
        id: "activity",
        threadId: f.threadId,
        source: {
          instanceId: "exec",
          nativeSessionId: "native",
          epoch: 1,
          eventId: "event",
          sourceId: "src",
          callId: "call",
        },
        assignment: { kind: "session" },
        phase: "started",
        inputSummary: "read",
        outputSummary: null,
        createdAt: 1000,
        createdPosition: "2",
        version: "1",
      };
      await f.seed([{ objectType: "timelineItem", value: item }]);
      const child = v.parse(ThreadIdSchema, "fork");
      await f.seed([
        {
          objectType: "thread",
          value: {
            id: child,
            projectId: "project-notes",
            worktreeId: null,
            title: "Fork",
            version: "1",
            lineage: {
              kind: "fork",
              parentThreadId: f.threadId,
              sourceRoundId: "round-1",
              sideChat: false,
            },
          },
        },
      ]);
      for (let i = 1; i <= 12; i++) await f.seed(turnRows(child, i + 100));
      const d = await f.connect("desktop"),
        phone = await f.connect("tablet");
      await op(d, child);
      await op(phone, child);
      const h = await d.at("16");
      await phone.at("16");
      const page = await d.client.history(h, null, () => true);
      expect(page.rows.some((r) => r.objectType === "timelineItem")).toBe(true);
      const ended = { ...item, phase: "ended", outputSummary: "128 bytes", version: "2" };
      await f.seed([{ objectType: "timelineItem", value: ended }]);
      await d.at("17");
      await phone.at("17");
      await installHistoryPage(d.cache, page, {
        head: h,
        threadId: child,
        anchor: page.anchor,
        timelineItems: true,
        allows: () => true,
      });
      for (const c of [d, phone])
        expect(visible(c).find((r) => r.objectType === "timelineItem")?.value).toEqual(
          v.parse(ToolActivityHistoryItemSchema, ended),
        );
      expect(cachedHistory(d.cache.read(), page.anchor, null)?.verified).toBe(false);
      const legacy = await f.connect("legacy", { directoryDiff: false, timeline: false });
      await op(legacy, child);
      const l = await legacy.at("17");
      const old = await legacy.client.history(l, null, () => true);
      expect(old.rows.some((r) => r.objectType === "timelineItem")).toBe(false);
      expect(cachedHistory(legacy.cache.read(), old.anchor, l)?.timelineItems).toBe(false);
      expect(
        legacy.messages
          .filter((m) => m.kind === "subscription.page")
          .flatMap((m) => v.parse(SubscriptionPageSchema, m.message).changes)
          .some((c) => c.kind === "tool.activity"),
      ).toBe(false);
    }),
  12000,
);
test(
  "S-STATE-054 a gap survives the seal and a failed local transaction leaves the old copy readable",
  () =>
    threadFixture(async (f) => {
      await f.start();
      const d = await f.connect("desktop");
      const o = await op(d, f.threadId);
      const p = await d.at("1"),
        before = d.cache.read();
      writeFileSync(join(f.stateDir, "unknown-change"), "hold");
      await f.seed(turnRows(f.threadId, 1));
      await until(
        () =>
          o.sub.state.status === "gap" || d.messages.some((m) => m.kind === "subscription.ended"),
        "gap",
      );
      await d.close();
      expect(d.cache.read()).toEqual(before);
      unlinkSync(join(f.stateDir, "unknown-change"));
      const failed = await f.connect("desktop", {
        store: {
          async transact(edit) {
            edit(before);
            throw Error("Injected local rollback");
          },
        },
      });
      const broken = await op(failed, f.threadId, p);
      await until(
        () =>
          broken.sub.state.status === "gap" ||
          failed.messages.some((m) => m.kind === "subscription.ended"),
        "rollback",
      );
      expect(failed.cache.read()).toEqual(before);
      expect(failed.heads).toEqual([]);
      await failed.close();
      const retry = await f.connect("desktop");
      await op(retry, f.threadId, p);
      await retry.at("2");
      expect(visible(retry).filter((r) => r.objectType === "message")).toHaveLength(1);
    }),
  10000,
);

test(
  "a resumed subscription installs an ordinary queued input and its negotiated attempt history",
  () =>
    threadFixture(async (f) => {
      const started = (await f.f.send()).receipt;
      if (started.kind !== "accepted" || started.result.kind !== "threadStarted")
        throw Error("Thread start failed");
      const { threadId } = started.result;
      const initial = await f.connect("reader", { minor: 1 });
      await op(initial, threadId);
      await until(() => initial.heads.length > 0, "initial installation");
      await initial.close();
      const base = initial.heads.at(-1);
      if (!base) throw Error("Missing initial cursor");
      const sender = await f.connect("sender", { minor: 1 });
      const receipt = await sender.client.rpc("input.send", {
        threadId,
        content: f.f.payload.content,
      });
      if (receipt.kind !== "accepted" || receipt.result.kind !== "inputScheduled")
        throw Error("Ordinary send was not accepted");
      const { roundId, messageId } = receipt.result;
      const reader = await f.connect("reader", { minor: 1 });
      await op(reader, threadId, base);
      const readRound = (client: Connection) =>
        visible(client).find((r) => r.objectType === "round" && r.value.id === roundId);
      await until(() => {
        const record = readRound(reader);
        return record?.objectType === "round" && record.value.attempt.phase.kind === "finished";
      }, "queue dispatch and installation");
      const rows = await f.f.client.subscribedRounds(threadId);
      const expected = rows.find((r) => r.id === roundId);
      expect(expected?.attempts?.at(-1)?.phase).toEqual(expected?.attempt.phase);
      expect(expected?.attempts?.at(-1)?.attemptId).toEqual(receipt.result.attemptId);
      expect(readRound(reader)?.value).toEqual(expected);
      expect(
        visible(reader).some(
          (row) =>
            row.objectType === "message" &&
            row.value.id === messageId &&
            row.value.text === f.f.payload.content.text,
        ),
      ).toBe(true);
      const legacy = await f.connect("legacy");
      await op(legacy, threadId);
      await until(() => legacy.heads.length > 0, "legacy installation");
      const old = readRound(legacy);
      expect(old?.objectType).toBe("round");
      expect(old?.value).not.toHaveProperty("attempts");
      expect(old?.value).not.toHaveProperty("steering");
    }),
  15000,
);
