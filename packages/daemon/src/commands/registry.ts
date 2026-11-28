import { worktreeWorkerCommand, runWorktreeWorker } from "@kraka/environment";
import { accessCli } from "../access";
import { threadListCli } from "@kraka/cli-client";
import { run as daemon } from "./daemon";
import { run as identity } from "./identity";
import { run as instance } from "./instance";
import { run as replay } from "./replay";
import { run as start } from "./start";
import { run as follow } from "./thread-follow";

const commands: [string, (args: string[]) => Promise<unknown>][] = [
  [worktreeWorkerCommand, (args) => runWorktreeWorker(args[0])],
  ["access", accessCli],
  ["daemon", daemon],
  ["identity", identity],
  ["instance", instance],
  ["replay", replay],
  ["start", start],
  ["thread follow", follow],
  ["thread list", threadListCli],
];

export async function runCommand(argv: string[]) {
  for (const [name, run] of commands) {
    const words = name.split(" ");
    if (words.every((word, i) => argv[i] === word)) return run(argv.slice(words.length));
  }
  throw new Error("Unknown command, expected start, identity, access, daemon or replay");
}
