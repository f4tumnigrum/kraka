import { expect, test } from "bun:test";
import { join } from "node:path";
import { withState } from "./fixtures/replay-process";
import { compare } from "./perf-compare";

function rename(role: "baseline" | "candidate", median: number, p99: number) {
  const summary = { series: "single", unit: "ms", median, p99, min: 0, max: p99 };
  return {
    metric: "P9",
    role,
    revision: role,
    probeRevision: "one probe",
    platform: "one runner",
    workload: "rename",
    status: "measured",
    result: median > 1.5 || p99 > 6 ? "breach" : "pass",
    actual: { single: 1250 },
    observations: [],
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
  const summary = { series: "rate", unit: "MB/s", min: 80, max: 120, p99: 119, median: 100 };
  const base = { ...a, metric: "P6" as const, thresholds: [throughput], summary: [summary] };
  const candidate = { ...base, role: "candidate" as const, summary: [{ ...summary, min: 65 }] };
  expect(compare(base, candidate)).toMatchObject({
    decision: "fail",
    delta: [{ baselineValue: 80, candidateValue: 65, candidateMinusBase: -15, tolerance: 12 }],
  });
});

test("an unavailable or nonmatching baseline leaves the candidate's own result in force", () => {
  const a = rename("baseline", 0.5, 7);
  const unavailable = { ...a, status: "unavailable" as const, reason: "no endpoint" };
  const candidate = rename("candidate", 0.5, 5);
  expect(compare(unavailable, candidate)).toMatchObject({
    status: "not comparable",
    decision: "pass",
    reason: "no endpoint",
  });
  expect(compare({ ...a, platform: "another host" }, rename("candidate", 0.5, 7))).toMatchObject({
    status: "not comparable",
    decision: "fail",
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
    await Bun.write(candidate, JSON.stringify(rename("candidate", 0.5, 5)));
    const absent = gate();
    expect(absent.exitCode).toBe(0);
    expect(JSON.parse(absent.stdout.toString())).toMatchObject({
      status: "not comparable",
      decision: "pass",
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
