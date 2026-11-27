import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { budgetWorkloads, parseSelection, prepareBudget, type ProbeReport } from "./perf";

type Turn = (nextBlock: () => Promise<void>) => Promise<void>;

export async function alternateBlocks(baseline: Turn, candidate: Turn) {
  const startCandidate = Promise.withResolvers<void>();
  let wakeOther = startCandidate.resolve;
  let finished = false;
  function nextBlock() {
    if (finished) return Promise.resolve();
    const next = Promise.withResolvers<void>();
    const wake = wakeOther;
    wakeOther = next.resolve;
    wake();
    return next.promise;
  }
  // A failed or shorter probe releases its partner for all remaining blocks.
  function finish() {
    finished = true;
    wakeOther();
  }
  const results = await Promise.allSettled([
    baseline(nextBlock).finally(finish),
    startCandidate.promise.then(() => candidate(nextBlock)).finally(finish),
  ]);
  for (const result of results) if (result.status === "rejected") throw result.reason;
}

if (import.meta.main) {
  const [baseRoot, out, ...ids] = Bun.argv.slice(2);
  if (!baseRoot || !out) throw new Error("Expected BASE_ROOT REPORT_DIR [metric IDs]");
  const workloads = budgetWorkloads(parseSelection(ids).metrics);
  const baseline = await prepareBudget(baseRoot, "baseline");
  const candidate = await prepareBudget(process.cwd(), "candidate");
  const trace = join(out, "budget-sampling.jsonl");
  const files = {
    baseline: join(out, "budget-baseline.jsonl"),
    candidate: join(out, "budget-candidate.jsonl"),
  };
  for (const path of [trace, ...Object.values(files)]) writeFileSync(path, "");
  for (const workload of workloads) {
    const run =
      (role: ProbeReport["role"], measure: typeof candidate): Turn =>
      async (nextBlock) => {
        let block = 0;
        const recordBlock = () => {
          block++;
          appendFileSync(trace, `${JSON.stringify({ ...workload, role, block })}\n`);
        };
        const report = await measure(workload, async () => {
          recordBlock();
          await nextBlock();
        });
        if (block === 0 && report.status === "measured") recordBlock();
        appendFileSync(files[role], `${JSON.stringify(report)}\n`);
        if (role === "candidate" && report.status === "failed") process.exitCode = 1;
      };
    await alternateBlocks(run("baseline", baseline), run("candidate", candidate));
  }
}
