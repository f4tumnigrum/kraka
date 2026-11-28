import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { runWorktreeWorker, worktreeWorkerCommand } from "@kraka/environment";
import { startWriter } from "../../packages/daemon/src/first-send";
import { fixture } from "./replay-process";
import { faults } from "./writer-scenarios/faults";
import { localDiff } from "./writer-scenarios/local-diff";
import { recovery } from "./writer-scenarios/recovery";
import { resume } from "./writer-scenarios/resume";
import { settings } from "./writer-scenarios/settings";
import type { Scenario } from "./writer-scenarios/fixture";
const scenarios = new Map<string, Scenario>([
  ["activity-ledger", resume],
  ["local-diff", localDiff],
  ["recovery", recovery],
  ["resume", resume],
  ["settings", settings],
]);
if (process.argv[2] === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}

const [stateDir, root, point] = process.argv.slice(2);
if (!stateDir || !root || !point) throw new Error("Expected state and product roots");
const recording = parseReplayRecording(readFileSync(join(root, fixture), "utf8"));
const adapter = createReplayAdapter(recording);
const setup = (scenarios.get(point) ?? faults)({
  state: stateDir,
  root,
  point,
  adapter,
  recording,
});
const writer = await startWriter(
  stateDir,
  {
    adapter,
    expectedText: recording.expectedText,
    modelId: recording.modelId,
    ...(setup.recovery && { recovery: setup.recovery }),
  },
  {
    ...setup.lifecycle,
    gitProcess(directory, granularity) {
      process.send?.({ event: "gitProcess", directory, granularity });
    },
  },
);
if (writer.kind === "unconfirmed") throw new Error(writer.reason);
if (writer.kind === "ready") {
  if (point === "settings" && process.connected) process.once("disconnect", writer.close);
  process.once("SIGTERM", writer.close);
  process.once("SIGINT", writer.close);
}
console.log(JSON.stringify({ kind: writer.kind, publication: writer.instance }));
