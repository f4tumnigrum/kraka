import { readReceipt, openReceiptReader } from "@kraka/environment";
import { scopeKey } from "../packages/client-runtime/src";
import type { SyncCursor, SubscriptionPage } from "@kraka/protocol";
import { threadFixture, turnRows } from "./fixtures/thread-resume";
import { within } from "./fixtures/replay-process";
import type { ReportBase } from "./perf";

export async function measureThreadResume(
  base: ReportBase,
  root: string,
  id: "P3" | "P4",
  nextBlock: () => Promise<void>,
) {
  if (id === "P3") {
    base.expected = { updates: 1250, warmups: 250 };
    base.actual = { updates: 0, warmups: 0 };
    for (let run = 0; run < 5; run++) {
      await threadFixture(async (f) => {
        await f.start();
        let applied = 0,
          persisted = 0,
          title = "",
          receive = 0;
        let installed = Promise.withResolvers<SyncCursor>();
        let remoteAck = Promise.withResolvers<SyncCursor>(),
          localAck = Promise.withResolvers<SyncCursor>();
        const other = await f.connect("tablet", {
          acknowledged: (h) => remoteAck.resolve(h),
          received(kind, raw, at) {
            if (kind !== "subscription.page") return;
            const p = raw as SubscriptionPage;
            if (
              p.changes.some(
                (c) =>
                  c.kind === "object.replace" &&
                  c.object.objectType === "thread" &&
                  c.object.value.title === title,
              )
            )
              receive = at;
          },
          timing(a, p) {
            applied = a;
            persisted = p;
          },
          installed(h) {
            installed.resolve(h);
          },
        });
        let receiptArrival = 0;
        const writer = await f.connect("desktop", {
          acknowledged: (h) => localAck.resolve(h),
          received: (kind, msg, at) => {
            if (
              kind === "accepted" &&
              (msg as { result: { kind: string } }).result.kind === "threadRenamed"
            )
              receiptArrival = at;
          },
        });
        await (await writer.client.open(f.threadId, null)).receipt;
        await writer.at("1");
        await (await other.client.open(f.threadId, null)).receipt;
        await other.at("1");
        for (let i = 0; i < 300; i++) {
          await within(
            Promise.all([remoteAck.promise, localAck.promise]),
            5000,
            "prior pass acknowledged",
          );
          remoteAck = Promise.withResolvers();
          localAck = Promise.withResolvers();
          title = "rename-" + run + "-" + i;
          receive = 0;
          installed = Promise.withResolvers<SyncCursor>();
          const start = performance.now();
          const sent = await writer.client.rpc("thread.rename", { threadId: f.threadId, title }),
            receipt = receiptArrival;
          const h = await within(installed.promise, 5000, "replicated rename");
          const cache = other.cache.read(),
            row = cache.rows['["thread","thread-notes"]']?.row;
          const db = openReceiptReader(f.stateDir);
          let committed: ReturnType<typeof readReceipt>;
          try {
            committed = readReceipt(db, writer.principal, sent.commandId);
          } finally {
            db.close();
          }
          if (
            sent.kind !== "accepted" ||
            sent.result.kind !== "threadRenamed" ||
            !committed ||
            committed.position !== h.through ||
            row?.objectType !== "thread" ||
            row.value.version !== sent.result.version ||
            row.value.title !== title ||
            receive <= start ||
            cache.scopes[scopeKey(h)]?.cursor.through !== h.through
          )
            throw Error("Rename lacks a matching second-client receipt, object or head");
          if (i < 50) {
            base.actual.warmups!++;
            continue;
          }
          base.actual.updates!++;
          base.samples.push(
            { series: "sendToReceive", unit: "ms", value: receive - start },
            { series: "receiptToReceive", unit: "ms", value: receive - receipt },
          );
          base.observations.push({
            run,
            i,
            commandId: sent.commandId,
            position: h.through,
            version: row.value.version,
            applyMs: applied,
            persistMs: persisted,
          });
        }
      }, root);
      await nextBlock();
    }
    return { sendToReceive: 1250, receiptToReceive: 1250 };
  }
  base.expected = { cold: 10, short: 10, long: 10 };
  base.actual = { cold: 0, short: 0, long: 0 };
  for (let trial = 0; trial < 10; trial++) {
    await threadFixture(async (f) => {
      await f.start();
      const range = (from: number, to: number) =>
        Array.from({ length: to - from + 1 }, (_, n) => turnRows(f.threadId, from + n));
      await f.control({ transactions: range(1, 25) });
      const long = await f.connect("long");
      await (await long.client.open(f.threadId, null)).receipt;
      const at25 = await long.at("26");
      await long.close();
      await f.control({ transactions: range(26, 29) });
      const short = await f.connect("short");
      await (await short.client.open(f.threadId, null)).receipt;
      const at29 = await short.at("30");
      await short.close();
      await f.control({ transactions: range(30, 30) });
      const db = openReceiptReader(f.stateDir);
      let expected: string[];
      try {
        expected = db
          .query<{ id: string }, []>("SELECT id FROM messages ORDER BY rowid DESC LIMIT 10")
          .all()
          .map((r) => r.id)
          .sort();
      } finally {
        db.close();
      }
      for (const [name, after] of [
        ["cold", null],
        ["short", at29],
        ["long", at25],
      ] as const) {
        const done = Promise.withResolvers<{ head: SyncCursor; at: number; bytes: number }>();
        let applyMs = 0,
          persistMs = 0;
        const c = await f.connect(name, {
          installed(head) {
            done.resolve({ head, at: performance.now(), bytes: c.bytes() });
          },
          timing(a, p) {
            applyMs = a;
            persistMs = p;
          },
        });
        const bytes = c.bytes(),
          start = performance.now();
        await (await c.client.open(f.threadId, after)).receipt;
        const end = await within(done.promise, 4000, "catch-up install");
        const elapsed = end.at - start,
          wire = end.bytes - bytes;
        const cache = c.cache.read(),
          scope = cache.scopes[scopeKey(end.head)];
        const keys = Object.keys(scope?.members ?? {}).sort(),
          want = [
            JSON.stringify(["thread", f.threadId]),
            ...expected.flatMap((id) => [
              JSON.stringify(["message", id]),
              JSON.stringify(["round", id.replace("message-", "round-")]),
            ]),
          ].sort();
        if (
          end.head.through !== "31" ||
          scope?.cursor.through !== "31" ||
          !Bun.deepEquals(keys, want) ||
          expected.some((id) => {
            const row = cache.rows[JSON.stringify(["message", id])]?.row;
            return row?.objectType !== "message" || row.value.text !== "Message " + id.slice(8);
          })
        )
          throw Error("Catch-up did not install the writer's expected window");
        base.actual[name]!++;
        base.samples.push(
          { series: name, unit: "B", value: wire },
          { series: name, unit: "ms", value: elapsed },
        );
        base.observations.push({
          trial,
          name,
          head: end.head.through,
          members: keys.length,
          wireBytes: wire,
          elapsedMs: elapsed,
          applyMs,
          persistMs,
        });
        await c.close();
      }
    }, root);
    await nextBlock();
  }
  return { cold: 10, short: 10, long: 10 };
}
