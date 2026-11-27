import { listWireProfile } from "./list-wire-profile";
import { installedList } from "../packages/client-runtime/src";
import { threadFixture, turnRows } from "./fixtures/thread-resume";
import { within } from "./fixtures/replay-process";
import type { ReportBase } from "./perf";
import type { WireMessage, SyncCursor } from "@kraka/protocol";

export async function measureThreadList(
  base: ReportBase,
  root: string,
  nextBlock: () => Promise<void>,
) {
  base.expected = { small: 1, cold: 5, warm: 50 };
  base.actual = { small: 0, cold: 0, warm: 0 };
  for (const size of [20, 1000])
    await threadFixture(async (f) => {
      const ids = Array.from({ length: size }, (_, i) => "t" + String(i).padStart(4, "0"));
      const rows = ids.flatMap((id, i) => [
        {
          objectType: "thread",
          value: {
            id,
            projectId: "p" + (i % (size === 20 ? 1 : 20)),
            title: id,
            worktreeId: null,
            lineage: { kind: "root" },
            version: "1",
          },
        },
        ...turnRows(id, i).map((row) =>
          row.objectType !== "round"
            ? row
            : {
                ...row,
                value: {
                  ...row.value,
                  attempt: {
                    attemptId: "a" + i,
                    deliveryId: "d" + i,
                    phase: {
                      kind: "finished",
                      root: { id: "r" + i, sessionId: "s", beganAt: 0 },
                      receipt: null,
                      endedAt: 1,
                      captureId: "c" + i,
                    },
                  },
                },
              },
        ),
      ]);
      await f.seed(rows);
      let baseHead: SyncCursor | null = null;
      for (let i = 0; i < (size === 20 ? 1 : 55); i++) {
        const series = size === 20 ? "small" : i < 5 ? "cold" : "warm";
        const signal = Promise.withResolvers<SyncCursor>();
        const frames: WireMessage[] = [];
        const peer = await f.connect("p5-" + (series === "warm" ? 4 : i), {
          installed: signal.resolve,
          captureReply: (wire) => frames.push(wire),
        });
        frames.length = 0;
        try {
          const before = peer.replyBytes(),
            start = performance.now();
          const opened = await peer.client.openList(
            null,
            series === "warm" ? baseHead : null,
            series !== "warm",
          );
          if ((await opened.receipt).kind !== "accepted") throw Error("List rejected");
          const head = await within(signal.promise, 20000, "verified list");
          const reading = installedList(peer.cache.read(), opened.sub.state);
          if (
            !reading ||
            reading.head.through !== head.through ||
            reading.threadIds.length !== size ||
            reading.threadIds.some((id, n) => id !== ids[n]) ||
            reading.counts.active !== size ||
            Object.entries(reading.counts).some(([k, v]) => k !== "active" && v !== 0) ||
            reading.rows.some(
              (r, i) =>
                r.summary.projectId !== "p" + (i % (size === 20 ? 1 : 20)) ||
                r.summary.lastActivityAt !== r.summary.createdAt ||
                r.summary.lifecycle.archivedAt !== null ||
                r.summary.lifecycle.state.kind !== "active" ||
                r.activity[0]?.requests.length !== 0 ||
                r.activity[0]?.rounds[0]?.round.id !== "round-" + i ||
                r.activity[0]?.rounds[0]?.round.attempt.deliveryId !== "d" + i ||
                r.activity[0]?.rounds[0]?.round.attempt.attemptId !== "a" + i ||
                r.summary.openTodos ||
                r.summary.activeRounds ||
                r.activity[0]?.rounds.length !== 1 ||
                r.activity[0]?.rounds[0]?.round.attempt.phase.kind !== "finished",
            )
          )
            throw Error("List differs from independent single-turn seed");
          const ms = performance.now() - start,
            bytes = peer.replyBytes() - before;
          baseHead = head;
          base.actual[series]!++;
          if (series !== "small") base.samples.push({ series, unit: "ms", value: ms });
          base.samples.push({ series: "response", unit: "B", value: bytes });
          base.observations.push({
            size,
            series,
            members: reading.threadIds.length,
            head: head.through,
            ms,
            bytes,
            ...listWireProfile(frames, size === 1000 && i === 0),
          });
        } finally {
          await peer.close();
        }
        await nextBlock();
      }
    }, root);
  return { cold: 5, warm: 50, response: 56 };
}
