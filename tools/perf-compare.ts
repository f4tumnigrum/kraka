import * as v from "valibot";
import { metricIds } from "./perf-catalog";

const series = v.object({
  series: v.string(),
  unit: v.string(),
  median: v.number(),
  min: v.number(),
  max: v.number(),
});
const report = v.object({
  metric: v.picklist(metricIds),
  role: v.picklist(["candidate", "baseline"]),
  revision: v.nullable(v.string()),
  digest: v.optional(v.string()),
  probeRevision: v.unknown(),
  platform: v.unknown(),
  workload: v.string(),
  status: v.picklist(["measured", "unavailable", "failed"]),
  reason: v.optional(v.string()),
  error: v.optional(v.string()),
  summary: v.optional(v.array(series)),
  observations: v.array(v.unknown()),
  actual: v.record(v.string(), v.number()),
});
type Report = v.InferOutput<typeof report>;
function scope(r: Report) {
  if (r.metric === "A2")
    return {
      counts: r.actual,
      suite: r.observations.map((o) => v.parse(v.object({ suiteDigest: v.string() }), o)),
    };
  if (r.metric === "P2")
    return r.observations.map((o) =>
      v.parse(v.object({ source: v.string(), unit: v.string() }), o),
    );
  return r.actual.launches;
}

export function compare(base: Report, candidate: Report) {
  const meta = { metric: candidate.metric, baseline: base.revision, candidate: candidate.revision };
  const gap = (reason: string) => ({
    ...meta,
    status: "not comparable",
    reason,
    ...(candidate.status === "measured"
      ? { firstCompleteBaseline: candidate.digest ?? candidate.revision }
      : {}),
  });
  if (
    base.role !== "baseline" ||
    candidate.role !== "candidate" ||
    base.metric !== candidate.metric
  )
    throw new Error("Mismatched role or metric");
  for (const r of [base, candidate])
    if (r.status !== "measured") return gap(`${r.role}: ${r.reason ?? r.error ?? r.status}`);
  if (
    base.workload !== candidate.workload ||
    !Bun.deepEquals(base.platform, candidate.platform) ||
    !Bun.deepEquals(base.probeRevision, candidate.probeRevision) ||
    !Bun.deepEquals(scope(base), scope(candidate))
  )
    return gap("Different host, probe revision, workload, suite scope or memory method");
  const before = base.summary,
    after = candidate.summary;
  if (!before?.length || !after?.length || before.length !== after.length)
    return gap("Missing matched summaries");
  const delta = [];
  for (const s of after) {
    const b = before.find((x) => x.series === s.series && x.unit === s.unit);
    if (!b) return gap(`Missing matched ${s.series} in ${s.unit}`);
    delta.push({
      series: s.series,
      unit: s.unit,
      candidateMinusBase: s.median - b.median,
      observedRangesOverlap: s.min <= b.max && b.min <= s.max,
    });
  }
  return { ...meta, status: "matched", delta };
}
async function reports(path: string) {
  const rows = (await Bun.file(path).text())
    .trim()
    .split("\n")
    .map((line) => v.parse(report, JSON.parse(line)));
  const map = new Map(rows.map((r) => [r.metric, r]));
  if (rows.length !== map.size) throw new Error(`Duplicate metric in ${path}`);
  return map;
}
if (import.meta.main) {
  const [baseFile, candidateFile] = Bun.argv.slice(2);
  if (!baseFile || !candidateFile) throw new Error("Expected baseline and candidate JSONL paths");
  const base = await reports(baseFile),
    candidate = await reports(candidateFile);
  for (const metric of metricIds) {
    const a = base.get(metric),
      b = candidate.get(metric);
    if (!a && !b) continue;
    if (!a || !b) throw new Error(`Missing final report for ${metric}`);
    console.log(JSON.stringify(compare(a, b)));
  }
}
