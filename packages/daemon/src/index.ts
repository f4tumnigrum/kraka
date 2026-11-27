import "@kraka/cli-client";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { runReplayTurn, type ProviderAdapter } from "@kraka/environment";
import { ReplayRunRequestSchema } from "@kraka/protocol";
import * as v from "valibot";
import { listenFlow } from "./flow-socket";

type SocketState = { claimed: boolean; controller: AbortController; terminal: boolean };
async function replay(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      recording: { type: "string" },
      port: { type: "string" },
    },
    strict: true,
    allowPositionals: false,
  });
  if (
    !values["state-dir"] ||
    !values.recording ||
    !values.port ||
    !/^\d+$/.test(values.port) ||
    Number(values.port) > 65535
  )
    throw new Error("Expected replay --state-dir DIR --recording FILE --port 0..65535");
  const workingDirectory = resolve(values["state-dir"]);
  const recording = parseReplayRecording(await Bun.file(resolve(values.recording)).text());
  const { shutdown, ready } = await listenReplay({
    workingDirectory,
    port: Number(values.port),
    expectedText: recording.expectedText,
    modelId: recording.modelId,
    adapter: createReplayAdapter(recording),
  });
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  process.stdout.write(ready);
}

export async function listenReplay<H extends object>({
  workingDirectory,
  port,
  expectedText,
  modelId,
  adapter,
}: {
  workingDirectory: string;
  port: number;
  expectedText: string;
  modelId: string;
  adapter: ProviderAdapter<"replay", H>;
}) {
  await mkdir(workingDirectory, { recursive: true });
  const sockets = new Set<Bun.ServerWebSocket<SocketState>>();
  const runs = new Set<Promise<void>>();
  function finish(ws: Bun.ServerWebSocket<SocketState>, code: number) {
    if (ws.data.terminal) return;
    ws.data.terminal = true;
    ws.data.controller.abort();
    ws.close(code);
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req, srv) {
      if (
        new URL(req.url).pathname === "/replay" &&
        !req.url.includes("?") &&
        srv.upgrade(req, {
          data: { claimed: false, terminal: false, controller: new AbortController() },
        })
      )
        return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      data: {} as SocketState,
      open(ws) {
        sockets.add(ws);
      },
      message(ws, frame) {
        if (ws.data.claimed || typeof frame !== "string") {
          finish(ws, 1007);
          return;
        }
        ws.data.claimed = true;
        let request: v.InferOutput<typeof ReplayRunRequestSchema>;
        try {
          request = v.parse(ReplayRunRequestSchema, JSON.parse(frame));
        } catch {
          finish(ws, 1007);
          return;
        }
        // Let the socket dispatch frames already queued behind this request.
        const run = Bun.sleep(0)
          .then(() =>
            runReplayTurn({
              request,
              adapter,
              expectedText,
              modelId,
              workingDirectory,
              signal: ws.data.controller.signal,
              emit(message) {
                if (ws.data.terminal || ws.send(JSON.stringify(message)) === 0)
                  throw new Error("Replay socket closed");
              },
            }),
          )
          .then(
            () => finish(ws, 1000),
            () => finish(ws, 1011),
          );
        runs.add(run);
        void run.finally(() => runs.delete(run));
      },
      close(ws) {
        ws.data.terminal = true;
        ws.data.controller.abort();
        sockets.delete(ws);
      },
    },
  });
  const url = `ws://127.0.0.1:${server.port}/replay`;
  const ready = `${JSON.stringify({ kind: "ready", url })}\n`;
  const temp = join(workingDirectory, `.replay-${crypto.randomUUID()}.tmp`);
  try {
    await writeFile(temp, ready, { flag: "wx" });
    await rename(temp, join(workingDirectory, "replay-endpoint.json"));
  } catch (error) {
    await server.stop(true);
    await rm(temp, { force: true });
    throw error;
  }
  async function shutdown() {
    for (const ws of sockets) finish(ws, 1001);
    await server.stop(true);
    await Promise.allSettled(runs);
  }
  return { shutdown, ready, url };
}
if (import.meta.main && process.argv.length > 2) {
  try {
    if (process.argv[2] === "daemon") {
      const { values } = parseArgs({
        args: process.argv.slice(3),
        options: {
          "state-dir": { type: "string" },
          listen: { type: "string" },
          port: { type: "string" },
        },
      });
      if (!values["state-dir"] || !values.listen || !values.port || !/^\d+$/.test(values.port))
        throw new Error("Expected daemon --state-dir DIR --listen 127.0.0.1 --port N");
      const listener = await listenFlow({
        stateDir: values["state-dir"],
        host: values.listen,
        port: Number(values.port),
      });
      process.once("SIGTERM", listener.shutdown);
      process.once("SIGINT", listener.shutdown);
      process.stdout.write(`${JSON.stringify(listener.ready)}\n`);
    } else if (process.argv[2] === "replay") await replay(process.argv.slice(3));
    else throw new Error("Unknown command, expected replay or daemon");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
