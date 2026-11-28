import { parseInstalledCommand } from "./installed-arguments";
import { resolve } from "node:path";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { startWriter } from "../first-send";
import { startForeground } from "../foreground";
export async function run(args: string[]) {
  const parsed = parseInstalledCommand("start", args);
  if (parsed.kind === "foreground") await startForeground(parsed.stateDir, parsed.action);
  else {
    const recording =
      parsed.recording === null
        ? null
        : parseReplayRecording(await Bun.file(resolve(parsed.recording)).text());
    const writer = await startWriter(
      parsed.stateDir,
      recording
        ? {
            adapter: createReplayAdapter(recording),
            modelId: recording.modelId,
            expectedText: recording.expectedText,
          }
        : null,
    );
    if (writer.kind === "unconfirmed") throw new Error(writer.reason);
    if (writer.kind === "ready") {
      process.once("SIGTERM", writer.close);
      process.once("SIGINT", writer.close);
    }
    console.log(JSON.stringify({ kind: writer.kind, publication: writer.instance }));
  }
}
