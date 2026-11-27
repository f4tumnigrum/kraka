import { parseArgs } from "node:util";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  ReplayRunRequestSchema,
  ReplayTurnUpdateSchema,
  validateReplayUpdate,
  type CommandReceipt,
  type ReplayRunRequest,
  type ReplayTurnUpdate,
} from "@kraka/protocol";

export function driveReplay(
  url: string,
  request: ReplayRunRequest,
  onMessage: (message: CommandReceipt | ReplayTurnUpdate) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    let receipt: CommandReceipt | undefined;
    const updates: ReplayTurnUpdate[] = [];
    const fail = (reason: unknown) => {
      clearTimeout(timeout);
      socket.terminate();
      reject(reason);
    };
    const timeout = setTimeout(() => fail(new Error("Replay client deadline exceeded")), 10_000);
    socket.onopen = () => socket.send(JSON.stringify(request));
    socket.onmessage = ({ data }) => {
      try {
        if (typeof data !== "string") throw new Error("Expected a replay text message");
        const json: unknown = JSON.parse(data);
        if (!receipt) {
          receipt = v.parse(CommandReceiptSchema, json);
          if (
            receipt.commandId !== request.commandId ||
            (receipt.kind !== "rejected" &&
              !(receipt.kind === "accepted" && receipt.result.kind === "threadStarted"))
          )
            throw new Error("Unexpected command receipt");
          onMessage(receipt);
        } else {
          if (receipt.kind !== "accepted" || receipt.result.kind !== "threadStarted")
            throw new Error("Update after rejection");
          const u = v.parse(ReplayTurnUpdateSchema, json);
          validateReplayUpdate(receipt.result, updates, u);
          updates.push(u);
          onMessage(u);
        }
      } catch (error) {
        fail(error);
      }
    };
    socket.onerror = () => fail(new Error("Replay connection failed"));
    socket.onclose = ({ code }) => {
      clearTimeout(timeout);
      if (code !== 1000) reject(new Error(`Replay closed with ${code}`));
      else if (receipt?.kind === "rejected") reject(new Error(receipt.failure.kind));
      else if (updates.length !== 8) reject(new Error("Incomplete replay transcript"));
      else resolve();
    };
  });
}
if (import.meta.main) {
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        url: { type: "string" },
        "command-id": { type: "string" },
        mode: { type: "string" },
        text: { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.url) throw new Error("Missing --url");
    const request = v.parse(ReplayRunRequestSchema, {
      kind: "replay.run",
      commandId: values["command-id"],
      permission: values.mode,
      input: { text: values.text, attachments: [], references: [] },
    });
    await driveReplay(values.url, request, (m) => process.stdout.write(`${JSON.stringify(m)}\n`));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
