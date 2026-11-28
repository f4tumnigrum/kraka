import { AsyncLocalStorage } from "node:async_hooks";
import type { Boundary } from "./checkpoints";

export type GitStep = { step: string; ms: number };
type CaptureTrace = { steps: GitStep[]; lockWaitMs: number };
type StartupStep =
  | "writerLock"
  | "databaseAndQueues"
  | "owner"
  | "access"
  | "listener"
  | "registerRecovery"
  | "publish";
export type WriterStartupMark = (step: StartupStep) => void;
const startup = new AsyncLocalStorage<{ active: boolean; gitProcesses: number }>();

export function measureWriterStartup<T>(work: (mark: WriterStartupMark) => Promise<T>) {
  const start = performance.now(),
    trace = { active: true, gitProcesses: 0 };
  const steps: [StartupStep, number][] = [];
  let previous = start;
  const rounded = (n: number) => Math.round(n * 100) / 100;
  const mark = (step: StartupStep) => {
    const now = performance.now();
    steps.push([step, rounded(now - previous)]);
    previous = now;
    if (step === "publish") {
      trace.active = false;
      console.error(
        "Writer startup timing " +
          JSON.stringify({
            totalMs: rounded(now - start),
            processAgeMs: rounded(now),
            gitProcesses: trace.gitProcesses,
            steps,
          }),
      );
    }
  };
  return startup
    .run(trace, () => work(mark))
    .finally(() => {
      trace.active = false;
    });
}

const traces = new AsyncLocalStorage<CaptureTrace>();

export function observeCaptureGit<T>(steps: GitStep[], work: () => T): T {
  return traces.run({ steps, lockWaitMs: 0 }, work);
}
export function recordWorkerGit(steps: GitStep[]) {
  traces.getStore()?.steps.push(...steps);
  const boot = startup.getStore();
  if (boot?.active) boot.gitProcesses += steps.length;
}
export function recordCaptureWait(ms: number) {
  const trace = traces.getStore();
  if (trace) trace.lockWaitMs += ms;
}

// Select only known command names. Arguments can contain paths, refs and file contents.
const commands = new Set([
  "rev-parse",
  "ls-files",
  "read-tree",
  "add",
  "write-tree",
  "commit-tree",
  "pack-objects",
  "unpack-objects",
  "fsck",
  "update-ref",
  "symbolic-ref",
  "show-ref",
  "worktree",
  "diff",
  "diff-index",
  "diff-files",
]);
export function measureGit<T extends { pid: number }>(
  source: "worktree" | "git",
  args: string[],
  spawn: () => T,
): T {
  const trace = traces.getStore();
  const boot = startup.getStore();
  if (!trace && !boot?.active) return spawn();
  const start = performance.now();
  const child = spawn();
  if (child.pid > 0) {
    if (boot?.active) boot.gitProcesses++;
    if (trace) {
      let i = 0;
      while (args[i]?.startsWith("-")) i += args[i] === "-c" ? 2 : 1;
      const command = args[i] ?? "";
      const step = source + "." + (commands.has(command) ? command : "other");
      trace.steps.push({ step, ms: performance.now() - start });
    }
  }
  return child;
}
export async function measureCaptureBoundary<T>(boundary: Boundary, work: () => Promise<T>) {
  const trace: CaptureTrace = { steps: [], lockWaitMs: 0 },
    start = performance.now();
  try {
    return await traces.run(trace, work);
  } finally {
    const totalMs = performance.now() - start - trace.lockWaitMs;
    const rounded = (n: number) => Math.round(n * 100) / 100;
    console.error(
      "Checkpoint boundary timing " +
        JSON.stringify({
          boundary,
          totalMs: rounded(totalMs),
          otherMs: rounded(totalMs - trace.steps.reduce((sum, step) => sum + step.ms, 0)),
          gitProcesses: trace.steps.length,
          steps: trace.steps.map(({ step, ms }) => [step, rounded(ms)]),
        }),
    );
  }
}
