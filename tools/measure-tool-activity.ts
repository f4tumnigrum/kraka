import { openReceiptReader } from "@kraka/environment";
import { decodeFrame, type SyncCursor } from "@kraka/protocol";
import { utf8 } from "../packages/daemon/src/flow-socket";
import { accepted } from "./fixtures/first-send";
import { threadFixture } from "./fixtures/thread-resume";
import { expand, installedTool, toolFact } from "./fixtures/tool-activity";
import type { ReportBase } from "./perf";

export async function measureToolActivity(
  base: ReportBase,
  root: string,
  nextBlock: () => Promise<void>,
) {
  const size = 20_000_000,
    runs = 10;
  base.expected = { downloads: runs, outputBytes: size * runs };
  base.actual = { downloads: 0, outputBytes: 0 };
  let samples = 0;
  for (let trial = 0; trial < runs; trial++) {
    await threadFixture(async (f) => {
      await f.start();
      const output = "x".repeat(size - 1) + "\n";
      await f.control({
        activity: { ...toolFact(f.threadId, "ended", output, 0), inputJson: "{}" },
      });
      const installed = Promise.withResolvers<SyncCursor>();
      const receipts: Promise<{ id: string; sent: number; received: number }>[] = [];
      let active = false,
        received = 0,
        declared = 0,
        start = 0,
        end = 0;
      const hash = new Bun.CryptoHasher("sha256");
      const c = await f.connect("desktop", {
        installed: installed.resolve,
        wire(w) {
          if (!active) return;
          const frame = decodeFrame(w, utf8);
          if (frame.lane === "data" && frame.message.kind === "tool.activity.detail")
            declared = frame.message.reference.byteLength;
          if (!("payload" in frame)) return;
          if (!received) start = performance.now();
          received += frame.payload.length;
          hash.update(frame.payload);
          if (received === declared) end = performance.now();
        },
      });
      const sub = await c.client.open(f.threadId, null);
      await sub.receipt;
      await installed.promise;
      const item = installedTool(c);
      accepted(
        await c.client.rpc("subscription.close", {
          subscriptionId: sub.sub.state.request.payload.subscriptionId,
        }),
        "actionAccepted",
      );
      active = true;
      const timer = setInterval(() => {
        if (!start || end) return;
        const sent = performance.now();
        const r = c.client
          .rpc("thread.rename", {
            threadId: f.threadId,
            title: "transfer-" + trial + "-" + receipts.length,
          })
          .then((receipt) => {
            const received = performance.now();
            accepted(receipt, "threadRenamed");
            return { id: receipt.commandId.toString(), sent, received };
          });
        void r.catch(() => {});
        receipts.push(r);
      }, 20);
      try {
        const v = await (await expand(c, item)).at("1");
        clearInterval(timer);
        const matched = await Promise.all(receipts);
        if (
          !matched.length ||
          !start ||
          !end ||
          received !== declared ||
          v.reference.sha256 !== hash.digest("hex") ||
          v.body.output.kind !== "complete" ||
          v.body.output.text !== output ||
          v.body.exitCode !== 0
        )
          throw Error("Incomplete activity download");
        const db = openReceiptReader(f.stateDir);
        try {
          for (const r of matched) {
            if (
              r.sent < start ||
              r.sent > end ||
              !db.query("SELECT 1 FROM receipts WHERE actor=? AND command=?").get(c.principal, r.id)
            )
              throw Error("Unmatched in-window command");
            base.samples.push({ series: "download", unit: "ms", value: r.received - r.sent });
            samples++;
          }
        } finally {
          db.close();
        }
        base.actual.downloads!++;
        base.actual.outputBytes! += size;
        base.observations.push({
          trial,
          workload: "tool detail download",
          outputBytes: size,
          retainedBodyBytes: received,
          sha256: v.reference.sha256,
          exitCode: v.body.exitCode,
          commands: matched.length,
          firstByte: start,
          lastByte: end,
          receipts: matched,
        });
      } finally {
        clearInterval(timer);
        await Promise.allSettled(receipts);
      }
    }, root);
    await nextBlock();
  }
  return { download: samples };
}
