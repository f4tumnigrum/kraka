import * as v from "valibot";
import { budgetValue, exceedsBudget, metricIds } from "./perf-catalog";

const series = v.object({
  series: v.string(),
  unit: v.string(),
  count: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  median: v.number(),
  p99: v.number(),
  min: v.number(),
  max: v.number(),
});
const threshold = v.object({
  series: v.string(),
  unit: v.picklist(["ms", "MiB", "B", "MB", "MB/s", "B/turn", "packages"]),
  statistic: v.picklist(["median", "p99", "each"]),
  limit: v.number(),
  direction: v.optional(v.literal("min")),
});
const metadata = {
  metric: v.picklist(metricIds),
  variant: v.optional(v.picklist(["access.listSessions", "worktree.recovery", "browserTLS"])),
  role: v.picklist(["candidate", "baseline"]),
  revision: v.nullable(v.string()),
  digest: v.optional(v.string()),
  probeRevision: v.unknown(),
  platform: v.unknown(),
  workload: v.string(),
  observations: v.array(v.unknown()),
  actual: v.record(v.string(), v.number()),
};
const report = v.variant("status", [
  v.object({
    ...metadata,
    status: v.literal("measured"),
    result: v.picklist(["pass", "breach", "observation"]),
    thresholds: v.pipe(v.array(threshold), v.minLength(1)),
    summary: v.array(series),
    expected: v.record(v.string(), v.number()),
    observations: v.pipe(v.array(v.unknown()), v.minLength(1)),
    samples: v.array(
      v.object({ series: v.string(), unit: v.string(), value: v.pipe(v.number(), v.finite()) }),
    ),
  }),
  v.object({ ...metadata, status: v.literal("failed"), error: v.string() }),
  v.object({ ...metadata, status: v.literal("unavailable"), reason: v.string() }),
]);
type Report = v.InferOutput<typeof report>;
type Measured = Extract<Report, { status: "measured" }>;
type Threshold = Measured["thresholds"][number];

function scope(r: Measured) {
  if (r.metric === "A2")
    return {
      counts: r.actual,
      suite: r.observations.map((o) => v.parse(v.object({ suiteDigest: v.string() }), o)),
    };
  if (r.metric === "P2")
    return r.observations.map((o) =>
      v.parse(v.object({ source: v.string(), unit: v.string() }), o),
    );
  if (r.metric === "P11") return r.actual;
  return r.actual.launches;
}
function tolerance(t: Threshold, baseline: number) {
  const magnitude = Math.abs(baseline);
  switch (t.unit) {
    case "ms":
      if (t.statistic === "p99") return Math.max(3, 0.6 * magnitude);
      if (t.statistic === "each") return Math.max(25, 0.4 * magnitude);
      return Math.max(1, 0.4 * magnitude);
    case "MiB":
      return Math.max(2, 0.1 * magnitude);
    case "MB/s":
      return Math.max(1, 0.15 * magnitude);
    case "packages":
      return 0;
    default:
      return 0.05 * magnitude;
  }
}
function reading(r: Measured, t: Threshold, i: number) {
  const summary = r.summary[i];
  if (
    r.thresholds.length !== r.summary.length ||
    summary?.series !== t.series ||
    summary.unit !== t.unit ||
    r.samples.filter((sample) => sample.series === t.series && sample.unit === t.unit).length !==
      summary.count
  )
    throw new Error(`Invalid ${r.role} summary for ${r.metric} ${t.series} (${t.unit})`);
  return { summary, value: budgetValue(t, summary) };
}
export function compare(
  base: Report | undefined,
  candidate: Report,
  missingReason = "No baseline report for workload",
) {
  if (
    candidate.role !== "candidate" ||
    (base &&
      (base.role !== "baseline" ||
        base.metric !== candidate.metric ||
        base.variant !== candidate.variant))
  )
    throw new Error("Mismatched role or metric");
  const meta = {
    metric: candidate.metric,
    variant: candidate.variant,
    baseline: base?.revision ?? null,
    candidate: candidate.revision,
    baselineResult: base?.status === "measured" ? base.result : (base?.status ?? null),
    candidateResult: candidate.status === "measured" ? candidate.result : candidate.status,
  };
  if (candidate.status !== "measured") {
    const failed = candidate.status === "failed" || base?.status === "measured";
    return {
      ...meta,
      status: "not comparable",
      decision: failed ? "fail" : "skip",
      reason: candidate.status === "failed" ? candidate.error : candidate.reason,
    };
  }
  if (Object.entries(candidate.expected).some(([key, count]) => candidate.actual[key] !== count))
    throw new Error(`Incomplete candidate observations for ${candidate.metric}`);
  const readings = candidate.thresholds.map((t, i) => ({
    threshold: t,
    ...reading(candidate, t, i),
  }));
  const gap = (reason: string) => ({
    ...meta,
    status: "not comparable",
    reason,
    decision: "observe",
    note: "First baseline. See the local reference-machine measurement for the absolute budget.",
    firstCompleteBaseline: candidate.digest ?? candidate.revision,
    delta: readings.map(({ threshold: t, value }) => ({
      ...t,
      baselineValue: null,
      candidateValue: value,
      candidateMinusBase: null,
      decision: "observe",
    })),
  });
  if (!base) return gap(missingReason);
  if (base.status !== "measured") return gap(base.status === "failed" ? base.error : base.reason);
  if (
    base.workload !== candidate.workload ||
    !Bun.deepEquals(base.platform, candidate.platform) ||
    !Bun.deepEquals(base.probeRevision, candidate.probeRevision) ||
    !Bun.deepEquals(scope(base), scope(candidate)) ||
    !Bun.deepEquals(base.thresholds, candidate.thresholds)
  )
    return gap("Different host, probe revision, workload, scope, method or thresholds");
  const delta = readings.map(({ threshold: t, value: candidateValue, summary: b }, i) => {
    const { value: baselineValue, summary: a } = reading(base, t, i);
    const difference = candidateValue - baselineValue;
    const allowed = tolerance(t, baselineValue);
    const regression = t.direction === "min" ? -difference : difference;
    const newlyBreached = !exceedsBudget(t, baselineValue) && exceedsBudget(t, candidateValue);
    const proximityBoundary = t.direction === "min" ? 2 * t.limit : t.limit / 2;
    const nearBudget =
      t.direction === "min"
        ? candidateValue <= proximityBoundary
        : candidateValue >= proximityBoundary;
    const beyondTolerance = regression > allowed;
    const reason = newlyBreached
      ? "new budget breach"
      : !beyondTolerance
        ? "within tolerance"
        : nearBudget
          ? "regression beyond tolerance"
          : "beyond tolerance with ample budget headroom";
    const decision =
      candidate.result === "observation"
        ? "observe"
        : newlyBreached || (nearBudget && beyondTolerance)
          ? "fail"
          : beyondTolerance
            ? "observe"
            : "pass";
    return {
      ...t,
      baselineValue,
      candidateValue,
      candidateMinusBase: difference,
      tolerance: allowed,
      proximityBoundary,
      observedRangesOverlap: a.min <= b.max && b.min <= a.max,
      decision,
      reason,
    };
  });
  return {
    ...meta,
    status: "matched",
    decision: delta.some((d) => d.decision === "fail")
      ? "fail"
      : candidate.result === "observation"
        ? "observe"
        : "pass",
    delta,
  };
}
async function reports(path: string, role: Report["role"]) {
  const lines = (await Bun.file(path).text()).trim();
  if (!lines) throw new Error(`Empty ${role} report`);
  const rows = lines.split("\n").map((line) => v.parse(report, JSON.parse(line)));
  if (rows.some((r) => r.role !== role)) throw new Error(`Expected ${role} reports in ${path}`);
  const map = new Map(rows.map((r) => [r.variant ? `${r.metric}/${r.variant}` : r.metric, r]));
  if (map.size !== rows.length) throw new Error(`Duplicate metric in ${path}`);
  return map;
}
if (import.meta.main) {
  const [baseFile, candidateFile] = Bun.argv.slice(2);
  if (!baseFile || !candidateFile) throw new Error("Expected baseline and candidate JSONL paths");
  const candidate = await reports(candidateFile, "candidate");
  let base: Awaited<ReturnType<typeof reports>> | undefined, missingReason: string | undefined;
  try {
    base = await reports(baseFile, "baseline");
  } catch (error) {
    missingReason = `Cannot use PR baseline: ${String(error)}`;
    console.error(missingReason);
  }
  for (const metric of new Set([...candidate.keys(), ...(base?.keys() ?? [])])) {
    const b = candidate.get(metric),
      a = base?.get(metric);
    const result = b
      ? compare(a, b, missingReason)
      : {
          metric: a?.metric,
          variant: a?.variant,
          baseline: a?.revision,
          candidate: null,
          status: "not comparable",
          decision: "fail",
          reason: "Missing candidate report",
        };
    console.log(JSON.stringify(result));
    if (result.decision === "fail") process.exitCode = 1;
  }
}
