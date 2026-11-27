import { join } from "node:path";
import { CommandIdSchema, PrincipalIdSchema, type CommandReceipt } from "@kraka/protocol";
import {
  confirmWriter,
  openReceiptReader,
  readReceipt,
  readRound,
  readThread,
} from "@kraka/environment";
import * as v from "valibot";
import type { ReportBase } from "./perf";
import { currentFootprint, noChildren } from "./measure-replay";
import { startFirstSendFixture, accepted, waitFile } from "./fixtures/first-send";
import { connectFirstSend, fixtureActor } from "./fixtures/first-send-client";
import { withState } from "./fixtures/replay-process";
import { codexFixture } from "./fixtures/codex-turn";
import type { Unit } from "./perf-catalog";

type Fixture = Awaited<ReturnType<typeof startFirstSendFixture>>;
const options = (dir: string, root: string) => ({
  stateDir: join(dir, "state"),
  projectDirectory: join(dir, "project"),
  root,
  adapter: "replay" as const,
});
const sample = (base: ReportBase, series: string, value: number, unit: Unit = "ms") =>
  base.samples.push({ series, unit, value });
function verifyObservation(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function waitIdle(f: Pick<Fixture, "instance">) {
  const deadline = performance.now() + 8000;
  do {
    const idle = await confirmWriter(f.instance.stateDirectory, deadline, true);
    if (idle?.instanceId === f.instance.instanceId) return;
    await Bun.sleep(5);
  } while (performance.now() < deadline);
  throw new Error("Writer did not drain");
}
async function startup(
  base: ReportBase,
  root: string,
  idle: boolean,
): Promise<Record<string, number>> {
  const count = idle ? 10 : 20;
  base.workload = idle
    ? "Ten Codex stdio writers idle at first durable thread.start acceptance + 60 s"
    : "Ten fresh/reused Codex stdio writer pairs from spawn through durable thread.start acceptance";
  base.endpoint = "signed Codex first send, matching SQLite receipt, local app-server peer";
  base.expected = { launches: count, accepted: count, completed: count, joined: count };
  const counts = { launches: 0, accepted: 0, completed: 0, joined: 0 };
  base.actual = counts;
  for (let i = 0; i < 10; i++)
    await withState(async (dir) => {
      for (const series of idle ? ["idle"] : ["fresh", "reused"]) {
        const opts = options(dir, root);
        const f = await codexFixture(dir, {}, root, false);
        const before = f.ledger.rows().length;
        counts.launches++;
        try {
          if (series !== "reused") accepted((await f.configure()).receipt, "executorConfigured");
          accepted((await f.refresh()).receipt, "executorRefreshed");
          const { receipt } = await f.send();
          const at = performance.now();
          const ids = accepted(receipt, "threadStarted");
          const reader = openReceiptReader(opts.stateDir);
          let position: string;
          try {
            const row = readReceipt(
              reader,
              v.parse(PrincipalIdSchema, fixtureActor),
              receipt.commandId,
            );
            verifyObservation(
              row && Bun.deepEquals(row.receipt, receipt),
              "Missing durable Codex receipt",
            );
            position = row.position;
          } finally {
            reader.close();
          }
          counts.accepted++;
          await waitIdle(f);
          const native = f.ledger.rows().slice(before);
          const peers = native.filter((r) => r.event === "spawn").map((r) => r.handle);
          verifyObservation(
            peers.length === 2 &&
              native.filter((r) => r.event === "exit").length === peers.length &&
              native.filter((r) => r.event === "root").length === 1,
            "Missing probe/turn exit or root evidence",
          );
          const processes = {
            appServers: peers.length,
            protocolSchemas: native.filter((r) => r.event === "protocolSchema").length,
            versions: native.filter((r) => r.event === "version").length,
            remaining: 0,
          };
          const db = openReceiptReader(opts.stateDir);
          try {
            const phase = readRound(db, ids.roundId)?.attempt.phase;
            verifyObservation(
              phase?.kind === "closing" && phase.endTimeEvidence?.source === "executorReported",
              "Incomplete Codex turn",
            );
          } finally {
            db.close();
          }
          counts.completed++;
          const pid = f.child.pid;
          if (idle) {
            await Bun.sleep(Math.max(0, Math.ceil(at + 60000 - performance.now())));
            const alive = () => {
              verifyObservation(
                f.child.exitCode === null && f.child.signalCode === null && f.instance.pid === pid,
                "Original PID exited",
              );
              process.kill(pid, 0);
              noChildren(pid);
            };
            alive();
            const elapsedMs = performance.now() - at;
            const memory = await currentFootprint(pid);
            alive();
            verifyObservation(
              (await confirmWriter(f.instance.stateDirectory, performance.now() + 500, true))
                ?.instanceId === f.instance.instanceId,
              "Writer became active",
            );
            base.observations.push({
              pid,
              elapsedMs,
              commandId: receipt.commandId,
              position,
              nativeProcesses: processes,
              ...memory,
            });
            sample(base, "idle", memory.mib, "MiB");
          } else {
            base.observations.push({
              pid,
              series,
              commandId: receipt.commandId,
              position,
              nativeProcesses: processes,
              elapsedMs: at - f.started,
            });
            sample(base, series, at - f.started);
          }
        } finally {
          await f.close();
          counts.joined++;
        }
      }
    });
  return idle ? { idle: 10 } : { fresh: 10, reused: 10 };
}
async function restart(base: ReportBase, root: string) {
  base.expected = { seeded: 1020, restarts: 20, recoveries: 5 };
  const counts = { seeded: 0, restarts: 0, recoveries: 0 };
  base.actual = counts;
  const medians: number[] = [];
  for (const size of [20, 1000])
    await withState(async (dir) => {
      const opts = options(dir, root),
        seed = await startFirstSendFixture(opts);
      try {
        for (let i = 0; i < size; i++) {
          accepted((await seed.send()).receipt, "threadStarted");
          counts.seeded++;
        }
        await waitIdle(seed);
      } finally {
        await seed.close();
      }
      const series = size === 20 ? "small" : "large",
        times: number[] = [];
      for (let i = 0; i < 10; i++) {
        const f = await startFirstSendFixture(opts);
        const elapsed = performance.now() - f.started;
        try {
          const db = openReceiptReader(opts.stateDir);
          try {
            const row = db
              .query<{ count: number }, []>(
                "SELECT count(*) count FROM rounds WHERE json_extract(data,'$.attempt.phase.kind')='closing'",
              )
              .get();
            verifyObservation(row?.count === size, "Seeded completed thread count changed");
          } finally {
            db.close();
          }
          times.push(elapsed);
          sample(base, series, elapsed);
          counts.restarts++;
          base.observations.push({
            threads: size,
            instance: f.instance.instanceId,
            elapsedMs: elapsed,
          });
        } finally {
          await f.close();
        }
      }
      times.sort((a, b) => a - b);
      medians.push(((times[4] ?? NaN) + (times[5] ?? NaN)) / 2);
    });
  sample(base, "medianDifference", (medians[1] ?? NaN) - (medians[0] ?? NaN));
  for (let i = 0; i < 5; i++)
    await withState(async (dir) => {
      const opts = options(dir, root),
        f = await startFirstSendFixture({ ...opts, point: "externalWrite" });
      let ids: ReturnType<typeof accepted<"threadStarted">>;
      try {
        ids = accepted((await f.send()).receipt, "threadStarted");
        await waitFile(join(opts.stateDir, "entered-externalWrite"));
        await f.kill();
      } finally {
        await f.close();
      }
      const next = await startFirstSendFixture(opts);
      try {
        const db = openReceiptReader(opts.stateDir);
        try {
          const round = readRound(db, ids.roundId),
            elapsed = performance.now() - next.started;
          verifyObservation(
            round?.attempt.attemptId === ids.attemptId &&
              round.attempt.deliveryId === ids.deliveryId &&
              round.attempt.phase.kind === "uncertain",
            "Missing original uncertain attempt",
          );
          counts.recoveries++;
          sample(base, "recovery", elapsed);
          base.observations.push({
            roundId: ids.roundId,
            attempt: round.attempt,
            elapsedMs: elapsed,
          });
        } finally {
          db.close();
        }
      } finally {
        await next.close();
      }
    });
  return { large: 10, medianDifference: 1, recovery: 5 };
}
async function rename(base: ReportBase, root: string) {
  base.expected = { single: 1250, eight: 4000, warmups: 250, reopened: 5500 };
  const counts = { single: 0, eight: 0, warmups: 0, reopened: 0 };
  base.actual = counts;
  await withState(async (dir) => {
    const opts = options(dir, root),
      f = await startFirstSendFixture(opts);
    const clients = [f.client],
      seen = new Map<string, { title: string; receipt: CommandReceipt }>();
    let number = 0;
    try {
      const { threadId } = accepted((await f.send()).receipt, "threadStarted");
      for (let i = 1; i < 8; i++) clients.push(await connectFirstSend(opts.stateDir, f.instance));
      async function series(
        client: typeof f.client,
        tag: "single" | "eight",
        count: number,
        warmups: number,
      ) {
        for (let i = 0; i < count; i++) {
          const title = `rename-${++number}`,
            id = crypto.randomUUID();
          const at = performance.now();
          const { receipt } = await client.send("thread.rename", { threadId, title }, id);
          const elapsed = performance.now() - at;
          const result = accepted(receipt, "threadRenamed");
          verifyObservation(
            receipt.commandId === id && result.threadId === threadId && !seen.has(result.version),
            "Rename receipt mismatch",
          );
          seen.set(result.version, { title, receipt });
          if (i < warmups) counts.warmups++;
          else {
            counts[tag]++;
            sample(base, tag, elapsed);
          }
        }
      }
      for (let r = 0; r < 5; r++) await series(f.client, "single", 300, 50);
      for (let r = 0; r < 5; r++)
        await Promise.all(clients.map((client) => series(client, "eight", 100, 0)));
      const final = String(1 + number);
      verifyObservation(seen.size === number && seen.has(final), "Missing committed versions");
      for (const client of clients) client.close();
      await f.stop();
      const db = openReceiptReader(opts.stateDir),
        actor = v.parse(PrincipalIdSchema, fixtureActor);
      try {
        for (let version = 2; version <= number + 1; version++) {
          const expected = seen.get(String(version));
          verifyObservation(expected, "Version gap");
          const row = readReceipt(db, actor, v.parse(CommandIdSchema, expected.receipt.commandId));
          verifyObservation(
            row &&
              Bun.deepEquals(row.receipt, expected.receipt) &&
              JSON.parse(row.intent).payload.title === expected.title,
            "Reopened receipt or intent mismatch",
          );
          counts.reopened++;
        }
        const thread = readThread(db, threadId);
        verifyObservation(
          thread?.version === final && thread.title === seen.get(final)?.title,
          "Final thread mismatch",
        );
        base.observations.push({
          threadId,
          finalVersion: final,
          matchedSingle: base.actual.single,
          matchedEight: base.actual.eight,
        });
      } finally {
        db.close();
      }
    } finally {
      for (const c of clients) c.close();
      await f.close();
    }
  });
  return { single: 1250, eight: 4000 };
}
export async function measureFirstSend(
  base: ReportBase,
  root: string,
  id: "P1" | "P2" | "P7" | "P9",
): Promise<Record<string, number>> {
  switch (id) {
    case "P1":
    case "P2":
      return startup(base, root, id === "P2");
    case "P7":
      return restart(base, root);
    case "P9":
      return rename(base, root);
  }
}
