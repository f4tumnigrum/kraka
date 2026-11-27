import { ownedDirectory } from "../../packages/cli-client/src/private-directory";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import { accepted, productRoot, startFirstSendFixture, waitFile } from "./first-send";
import { connectFirstSend } from "./first-send-client";
import { terminate, withState } from "./replay-process";

const entry = v.object({
  step: v.string(),
  attemptId: AttemptIdSchema,
  deliveryId: DeliveryIdSchema,
  messageId: MessageIdSchema,
  sessionId: NativeSessionIdSchema,
  data: v.unknown(),
});
export async function eventually<T>(observe: () => Promise<T> | T, match: (x: T) => boolean) {
  const until = performance.now() + 5000;
  let result = await observe();
  while (!match(result)) {
    if (performance.now() >= until) throw Error("Missing observation: " + JSON.stringify(result));
    await Bun.sleep(5);
    result = await observe();
  }
  return result;
}
export function withInputPeer(
  run: (f: Awaited<ReturnType<typeof setup>>) => Promise<void>,
  holds: string[] = [],
) {
  return withState(async (dir) => {
    const f = await setup(dir, holds);
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
}
async function setup(dir: string, holds: string[]) {
  const stateDir = join(dir, "state");
  await ownedDirectory(stateDir);
  const hold = (step: string) => writeFileSync(join(stateDir, "hold-" + step), "");
  const release = (step: string) => rmSync(join(stateDir, "hold-" + step), { force: true });
  for (const step of holds) hold(step);
  const peer = Bun.spawn(
    [process.execPath, join(productRoot, "tools/fixtures/input-peer.ts"), stateDir],
    { stdout: "ignore", stderr: "inherit" },
  );
  const options = {
    stateDir,
    projectDirectory: join(dir, "project"),
    adapter: "replay",
    point: "recovery",
  } as const;
  const ledger = () => {
    const file = join(stateDir, "peer.jsonl");
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => v.parse(entry, JSON.parse(line)))
      : [];
  };
  try {
    await waitFile(join(stateDir, "peer.url"));
    let writer = await startFirstSendFixture(options);
    let client = writer.client;
    return {
      get writer() {
        return writer;
      },
      get client() {
        return client;
      },
      stateDir,
      ledger,
      hold,
      release,
      async reconnect() {
        client.close();
        client = await connectFirstSend(stateDir, writer.instance);
      },
      async restart() {
        await writer.kill();
        client.close();
        await writer.close();
        writer = await startFirstSendFixture(options);
        client = writer.client;
        await writer.awaitRecovery(writer.instance.instanceId);
      },
      async start() {
        return accepted((await writer.send()).receipt, "threadStarted");
      },
      async send(threadId: string, text = writer.payload.content.text, id?: string) {
        return accepted(
          (
            await client.send(
              "input.send",
              { threadId, content: { ...writer.payload.content, text } },
              id,
            )
          ).receipt,
          "inputScheduled",
        );
      },
      async seen(step: string, delivery?: string) {
        const rows = await eventually(ledger, (rows) =>
          rows.some((r) => r.step === step && (!delivery || r.deliveryId === delivery)),
        );
        return rows.find((r) => r.step === step && (!delivery || r.deliveryId === delivery))!;
      },
      async close() {
        for (const gate of [
          "claim",
          "beforeWrite",
          "afterWrite",
          "receipt",
          "turn",
          "start",
          "steer",
          "handoff",
        ])
          release(gate);
        client.close();
        try {
          await writer.close();
        } finally {
          await terminate(peer);
        }
      },
    };
  } catch (e) {
    await terminate(peer);
    throw e;
  }
}
