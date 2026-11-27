export const metricIds = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P10",
  "P11",
  "A1",
  "A2",
] as const;
export type Metric = (typeof metricIds)[number];
export type Unit = "ms" | "MiB" | "B" | "MB" | "MB/s" | "B/turn" | "packages";

interface Threshold {
  series: string;
  unit: Unit;
  statistic: "median" | "p99" | "each";
  limit: number;
  direction?: "min";
}
export interface ProbeSpec {
  workload: string;
  endpoint: string;
  thresholds: readonly Threshold[];
}
const median = (series: string, unit: Unit, limit: number): Threshold => ({
  series,
  unit,
  statistic: "median",
  limit,
});
const p99 = (series: string, unit: Unit, limit: number): Threshold => ({
  series,
  unit,
  statistic: "p99",
  limit,
});
const each = (series: string, unit: Unit, limit: number): Threshold => ({
  series,
  unit,
  statistic: "each",
  limit,
});

export const catalog: Record<Metric, ProbeSpec> = {
  P1: {
    workload:
      "Ten independent fresh/reused directory pairs, spawn to validated basic-turn acceptance, existing OS cache",
    endpoint: "replay.run",
    thresholds: [median("fresh", "ms", 500), median("reused", "ms", 300)],
  },
  P2: {
    workload: "Ten exclusive basic-turn daemons, drained and childless at acceptance + 60 s",
    endpoint: "replay.run and current PID footprint counter",
    thresholds: [median("idle", "MiB", 150)],
  },
  P3: {
    workload:
      "Five rounds of 300 serial same-thread renames from one client, discard first 50 per round, match 1,250 deliveries by thread, value and commit position on one clock, retain negative receipt offsets",
    endpoint: "two live clients subscribed to the same thread",
    thresholds: [
      median("sendToReceive", "ms", 1.8),
      p99("sendToReceive", "ms", 8),
      median("receiptToReceive", "ms", 0.3),
    ],
  },
  P4: {
    workload:
      "30-turn history, ten cold installs and ten each with one- and five-turn gaps, verify installed contents",
    endpoint: "bounded thread history subscription, delta and installed cursor",
    thresholds: [
      median("cold", "B", 81253),
      median("short", "ms", 11),
      median("short", "B", 49750),
      median("long", "B", 40627),
    ],
  },
  P5: {
    workload:
      "20 and 1,000 completed single-turn threads, verify membership on five cold and 50 warm reads of the larger seed",
    endpoint: "thread list query",
    thresholds: [
      median("cold", "ms", 186.8),
      median("warm", "ms", 123.1),
      each("response", "B", 954991),
    ],
  },
  P6: {
    workload:
      "Five 20 MB writes on a 120×40 PTY, verify byte count and checksum, 1,250 idle echoes and five reattachments",
    endpoint: "real PTY with input, output and reattachment",
    thresholds: [
      { ...median("throughput", "MB/s", 22.36), direction: "min" },
      each("missing", "B", 0),
      median("echo", "ms", 2.83),
      p99("echo", "ms", 3.39),
      median("firstSnapshot", "ms", 2.48),
    ],
  },
  P7: {
    workload:
      "Ten restarts each with 20 and 1,000 single-turn threads, five interrupted active turns reaching the same evidenced recovery state",
    endpoint: "persistent thread state and restart recovery",
    thresholds: [
      median("large", "ms", 600),
      each("medianDifference", "ms", 100),
      each("recovery", "ms", 2000),
    ],
  },
  P8: {
    workload:
      "Every downloadable daemon/CLI release by OS and architecture, report extracted single-file bytes separately",
    endpoint: "packaged daemon/CLI release archive",
    thresholds: [each("download", "MB", 120)],
  },
  P9: {
    workload:
      "Five rounds of 300 serial renames (50 warmups), then eight same-thread writers × 100 commands per round, match all 1,250 and 4,000 receipts",
    endpoint: "committed thread rename receipt",
    thresholds: [
      median("single", "ms", 1.5),
      p99("single", "ms", 6),
      median("eight", "ms", 8),
      p99("eight", "ms", 20),
    ],
  },
  P10: {
    workload:
      "Three fresh databases, one thread from one to 20 turns, 28 B user text, 34 B reply, tool 140 B in/96 B out, settled DB+WAL growth / 19, verify event count and separate retained checkpoints",
    endpoint: "durable completed turns and settled database/WAL sizes",
    thresholds: [median("growth", "B/turn", 20000)],
  },
  P11: {
    workload:
      "Ten uploads and ten downloads of 20,000,000 B, commands every 20 ms on the same connection, match receipts inside each transfer and verify bytes, keep generated data separate",
    endpoint: "control receipts during concurrent same-connection transfer",
    thresholds: [p99("upload", "ms", 20), p99("download", "ms", 20)],
  },
  A1: {
    workload:
      "One frozen installed daemon production dependency closure for this OS and architecture",
    endpoint: "daemon workspace manifest, bun.lock and installed packages",
    thresholds: [each("external", "packages", 15), each("native", "packages", 0)],
  },
  A2: {
    workload: "One unfiltered whole-workspace bun test process from spawn through exit",
    endpoint: "complete Bun test suite",
    thresholds: [each("suite", "ms", 60000)],
  },
};
