import { ownedDirectory } from "../../packages/cli-client/src/private-directory";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AttemptId, DeliveryId } from "@kraka/protocol";
import { entrySchema, type PeerEntry, type PeerCommand } from "./input-peer-control";
import * as v from "valibot";
import { accepted, productRoot, startFirstSendFixture } from "./first-send";
import { connectFirstSend } from "./first-send-client";
import { terminate, within, withState } from "./replay-process";

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
  const ready = Promise.withResolvers<string>();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<PeerEntry[]>>>();
  let failure: Error | undefined;
  function fail(error: Error) {
    failure = error;
    ready.reject(error);
    for (const waiter of pending.values()) waiter.reject(error);
  }
  const peer = Bun.spawn(
    [process.execPath, join(productRoot, "tools/fixtures/input-peer.ts"), stateDir, ...holds],
    {
      stdout: "ignore",
      stderr: "inherit",
      ipc(message) {
        try {
          const reply = v.parse(
            v.variant("kind", [
              v.object({ kind: v.literal("ready"), origin: v.string() }),
              v.object({ kind: v.literal("reply"), id: v.string(), rows: v.array(entrySchema) }),
            ]),
            message,
          );
          if (reply.kind === "ready") ready.resolve(reply.origin);
          else pending.get(reply.id)?.resolve(reply.rows);
        } catch (error) {
          fail(Error(String(error)));
        }
      },
    },
  );
  void peer.exited.then((code) => fail(Error("Input peer exited: " + (peer.signalCode ?? code))));
  async function control(command: PeerCommand) {
    if (failure) throw failure;
    const id = crypto.randomUUID(),
      waiter = Promise.withResolvers<PeerEntry[]>();
    pending.set(id, waiter);
    try {
      peer.send({ id, command });
      return await within(waiter.promise, 5000, "Input peer " + command.kind + " " + id);
    } finally {
      pending.delete(id);
    }
  }
  const options = {
    stateDir,
    projectDirectory: join(dir, "project"),
    adapter: "replay",
    point: "recovery",
  } as const;
  try {
    const origin = await within(ready.promise, 5000, "Input peer ready");
    writeFileSync(join(stateDir, "peer.url"), origin);
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
      ledger: () => control({ kind: "ledger" }),
      hold: (step: string) => control({ kind: "hold", step }),
      release: (step: string) => control({ kind: "release", step }),
      late: (attemptId: AttemptId, source: PeerEntry) =>
        control({ kind: "late", attemptId, source }),
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
      async seen(step: string, deliveryId: DeliveryId) {
        const [row] = await control({ kind: "seen", step, deliveryId });
        if (row?.step !== step || row.deliveryId !== deliveryId)
          throw Error("Unmatched input observation");
        return row;
      },
      async close() {
        try {
          if (!failure) await control({ kind: "releaseAll" });
        } finally {
          client.close();
          try {
            await writer.close();
          } finally {
            await terminate(peer);
          }
        }
      },
    };
  } catch (e) {
    await terminate(peer);
    throw e;
  }
}
