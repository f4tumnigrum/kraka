import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fixtures/replay-process";
import { compare } from "./perf-compare";
import { alternateBlocks } from "./perf-pair";

function rename(role: "baseline" | "candidate", median: number, p99: number) {
  const summary = { series: "single", unit: "ms", count: 100, median, p99, min: median, max: p99 };
  return {
    metric: "P9",
    role,
    revision: role,
    probeRevision: "one probe",
    platform: "one runner",
    workload: "rename",
    status: "measured",
    result: median > 1.5 || p99 > 6 ? "breach" : "pass",
    expected: { single: 100 },
    actual: { single: 100 },
    observations: [{ matchedSingle: 100 }],
    samples: Array.from({ length: 100 }, (_, i) => ({
      series: "single",
      unit: "ms",
      value: i < 98 ? median : p99,
    })),
    thresholds: [
      { series: "single", unit: "ms", statistic: "median", limit: 1.5 },
      { series: "single", unit: "ms", statistic: "p99", limit: 6 },
    ],
    summary: [summary, summary],
  } satisfies NonNullable<Parameters<typeof compare>[0]>;
}

test("an unchanged baseline p99 breach passes, and modest jitter within tolerance passes", () => {
  for (const p99 of [7.31, 8]) {
    const r = compare(rename("baseline", 0.6, 7.31), rename("candidate", 0.6, p99));
    expect(r).toMatchObject({
      status: "matched",
      decision: "pass",
      delta: [
        { statistic: "median", baselineValue: 0.6, candidateValue: 0.6 },
        { statistic: "p99", baselineValue: 7.31, candidateValue: p99, decision: "pass" },
      ],
    });
  }
});

test("a new p99 breach fails even when another threshold already breached and the increase is small", () => {
  const r = compare(rename("baseline", 1.6, 6), rename("candidate", 1.6, 6.01));
  expect(r).toMatchObject({
    decision: "fail",
    delta: [
      { decision: "pass" },
      { statistic: "p99", decision: "fail", reason: "new budget breach" },
    ],
  });
});

test("a regression beyond tolerance fails even inside the budget", () => {
  expect(compare(rename("baseline", 0.5, 1), rename("candidate", 0.5, 4))).toMatchObject({
    decision: "pass",
  });
  const r = compare(rename("baseline", 0.5, 1), rename("candidate", 0.5, 5));
  expect(r).toMatchObject({
    decision: "fail",
    delta: [
      { decision: "pass" },
      {
        baselineValue: 1,
        candidateValue: 5,
        candidateMinusBase: 4,
        tolerance: 3,
        reason: "regression beyond tolerance",
      },
    ],
  });
});

test("each uses the worst sample and throughput regresses downwards", () => {
  const a = rename("baseline", 1, 2);
  const throughput = {
    series: "rate",
    unit: "MB/s" as const,
    statistic: "each" as const,
    direction: "min" as const,
    limit: 20,
  };
  const summary = { series: "rate", unit: "MB/s", count: 1, min: 80, max: 80, p99: 80, median: 80 };
  const base = {
    ...a,
    metric: "P6" as const,
    thresholds: [throughput],
    summary: [summary],
    samples: [{ series: "rate", unit: "MB/s", value: 80 }],
  };
  const candidateAt = (value: number) => ({
    ...base,
    role: "candidate" as const,
    summary: [{ ...summary, min: value, max: value, median: value, p99: value }],
    samples: [{ series: "rate", unit: "MB/s", value }],
  });
  expect(compare(base, candidateAt(65))).toMatchObject({
    decision: "pass",
    delta: [{ decision: "observe", proximityBoundary: 40 }],
  });
  const candidate = candidateAt(40);
  expect(compare(base, candidate)).toMatchObject({
    decision: "fail",
    delta: [{ baselineValue: 80, candidateValue: 40, candidateMinusBase: -40, tolerance: 12 }],
  });
});

test("a missing or nonmatching baseline records the first valid measurement", () => {
  const a = rename("baseline", 0.5, 7);
  const unavailable = { ...a, status: "unavailable" as const, reason: "no endpoint" };
  const candidate = rename("candidate", 0.5, 5);
  expect(compare(unavailable, candidate)).toMatchObject({
    status: "not comparable",
    decision: "observe",
    firstCompleteBaseline: "candidate",
    reason: "no endpoint",
  });
  expect(compare({ ...a, platform: "another host" }, rename("candidate", 0.5, 7))).toMatchObject({
    status: "not comparable",
    decision: "observe",
    delta: [{ baselineValue: null }, { candidateValue: 7, candidateMinusBase: null }],
  });
  expect(
    compare(undefined, { ...candidate, status: "failed", error: "missing receipt" }),
  ).toMatchObject({ decision: "fail", reason: "missing receipt" });
  expect(
    compare(a, { ...candidate, status: "unavailable", reason: "endpoint lost" }),
  ).toMatchObject({ decision: "fail" });
});

test("the comparison CLI evaluates the candidate after a baseline setup failure and returns the gate exit code", async () => {
  await withState(async (dir) => {
    const base = join(dir, "base.jsonl"),
      candidate = join(dir, "candidate.jsonl");
    const gate = () =>
      Bun.spawnSync([process.execPath, join(import.meta.dir, "perf-compare.ts"), base, candidate], {
        stdout: "pipe",
        stderr: "pipe",
      });
    await Bun.write(candidate, JSON.stringify(rename("candidate", 0.5, 7)));
    const absent = gate();
    expect(absent.exitCode).toBe(0);
    expect(JSON.parse(absent.stdout.toString())).toMatchObject({
      status: "not comparable",
      decision: "observe",
    });
    await Bun.write(base, JSON.stringify(rename("baseline", 0.5, 1)));
    const regressed = gate();
    expect(regressed.exitCode).toBe(1);
    expect(JSON.parse(regressed.stdout.toString())).toMatchObject({
      status: "matched",
      decision: "fail",
    });
    await Bun.write(candidate, "");
    expect(gate().exitCode).toBe(1);
  });
});

test("first measured P3 on a virtual Mac keeps its breach as the first baseline", () => {
  const series = "receiptToReceive";
  const value = 0.677;
  const candidate = {
    ...rename("candidate", value, value),
    metric: "P3" as const,
    workload: "same-thread delivery",
    platform: "Apple M1 (Virtual)",
    result: "breach" as const,
    thresholds: [{ series, unit: "ms" as const, statistic: "median" as const, limit: 0.3 }],
    summary: [{ series, unit: "ms", count: 1, median: value, p99: value, min: value, max: value }],
    samples: [{ series, unit: "ms", value }],
    expected: { updates: 1 },
    actual: { updates: 1 },
    observations: [{ position: 1 }],
  };
  const base = {
    ...candidate,
    role: "baseline" as const,
    status: "unavailable" as const,
    reason: "Missing two live clients subscribed to the same thread",
  };
  expect(compare(base, candidate)).toMatchObject({
    status: "not comparable",
    decision: "observe",
    candidateResult: "breach",
    firstCompleteBaseline: "candidate",
    note: expect.stringContaining("local reference-machine"),
    delta: [{ candidateValue: value, candidateMinusBase: null, decision: "observe" }],
  });
  expect(() => compare(base, { ...candidate, samples: [] })).toThrow();
  expect(() => compare(base, { ...candidate, samples: [{ series, unit: "B", value }] })).toThrow();
  expect(() => compare(base, { ...candidate, actual: { updates: 0 } })).toThrow();
});

test("a worsening timing is reported below half the ceiling and gated at the boundary", () => {
  const base = rename("baseline", 0.1, 0.5);
  const previous = { ...base, thresholds: base.thresholds.map((t) => ({ ...t, limit: 20 })) };
  const at = (p99: number) => ({
    ...rename("candidate", 0.1, p99),
    thresholds: previous.thresholds,
    result: "pass" as const,
  });
  expect(compare(previous, at(9.9))).toMatchObject({
    decision: "pass",
    delta: [{ decision: "pass" }, { decision: "observe", proximityBoundary: 10 }],
  });
  expect(compare(previous, at(10))).toMatchObject({
    decision: "fail",
    delta: [{ decision: "pass" }, { decision: "fail" }],
  });
});

test("paired sampling alternates completed blocks and releases the other side after an early exit", async () => {
  const order: string[] = [];
  const blocks = (role: string, n: number) => async (next: () => Promise<void>) => {
    for (let i = 1; i <= n; i++) {
      order.push(role + i);
      await next();
    }
  };
  await alternateBlocks(blocks("A", 3), blocks("B", 3));
  expect(order).toEqual(["A1", "B1", "A2", "B2", "A3", "B3"]);
  order.length = 0;
  await expect(
    alternateBlocks(
      async (next) => {
        await blocks("A", 1)(next);
        throw Error("broken baseline");
      },
      blocks("B", 3),
    ),
  ).rejects.toThrow("broken baseline");
  expect(order).toEqual(["A1", "B1", "B2", "B3"]);
});
