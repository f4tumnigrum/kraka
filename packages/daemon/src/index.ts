import { listenBrowserDaemon } from "./browser-daemon";
import { accessCli } from "./access";
import { identityCommand, threadListCli, followThread } from "@kraka/cli-client";
import { startForeground } from "./foreground";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { parseArgs } from "node:util";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import {
  readInstancePublication,
  inspectInstancePublication,
  runWorktreeWorker,
  worktreeWorkerCommand,
  runReplayTurn,
  type ProviderAdapter,
} from "@kraka/environment";
import { ReplayRunRequestSchema, ThreadIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import { startWriter } from "./first-send";

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
type InstalledCommand =
  | { kind: "identity"; stateDir: string }
  | { kind: "foreground"; stateDir: string; action: "print" | "open" }
  | { kind: "writer"; stateDir: string; recording: string | null };
export function parseInstalledCommand(
  command: "identity" | "start",
  args: string[],
): InstalledCommand {
  if (command === "identity") {
    const { values } = parseArgs({
      args,
      options: { "state-dir": { type: "string" }, json: { type: "boolean" } },
      allowPositionals: false,
    });
    if (!values["state-dir"] || !values.json)
      throw Error("Expected identity --state-dir DIR --json");
    return { kind: "identity", stateDir: resolve(values["state-dir"]) };
  }
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      recording: { type: "string" },
      "local-owner": { type: "boolean" },
      "print-pairing": { type: "boolean" },
      "open-browser": { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!values["state-dir"])
    throw Error("Expected start --state-dir DIR [--print-pairing | --open-browser]");
  const stateDir = resolve(values["state-dir"]);
  if (
    [
      values.recording,
      values["local-owner"],
      values["print-pairing"],
      values["open-browser"],
    ].filter((value) => value !== undefined).length > 1
  )
    throw Error("Choose one startup mode");
  if (values.recording !== undefined || values["local-owner"])
    return { kind: "writer", stateDir, recording: values.recording ?? null };
  return { kind: "foreground", stateDir, action: values["open-browser"] ? "open" : "print" };
}
declare const KRAKA_DAEMON_ENTRY: boolean;
if ((typeof KRAKA_DAEMON_ENTRY !== "undefined" && KRAKA_DAEMON_ENTRY) || import.meta.main) {
  try {
    const [command, ...args] = process.argv.slice(2);
    if (command === worktreeWorkerCommand) await runWorktreeWorker(args[0]);
    else if (command === "thread" && args[0] === "list") await threadListCli(args.slice(1));
    else if (command === "thread" && args[0] === "follow") {
      const { values } = parseArgs({
        args: args.slice(1),
        options: {
          "state-dir": { type: "string" },
          thread: { type: "string" },
          jsonl: { type: "boolean" },
        },
        allowPositionals: false,
      });
      if (!values["state-dir"] || !values.jsonl)
        throw Error("Expected thread follow --state-dir DIR --thread T --jsonl");
      const thread = v.parse(ThreadIdSchema, values.thread);
      const publication = await readInstancePublication(resolve(values["state-dir"]));
      if (!publication) throw Error("Environment unavailable");
      const scope = new AbortController();
      const cancel = () => scope.abort();
      process.once("SIGINT", cancel);
      process.once("SIGTERM", cancel);
      try {
        await followThread(publication.environmentId, publication.endpoint, thread, scope.signal);
      } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
      }
    } else if (command === "instance") {
      const { values } = parseArgs({
        args,
        options: { "state-dir": { type: "string" }, json: { type: "boolean" } },
        allowPositionals: false,
      });
      if (!values["state-dir"] || !values.json)
        throw Error("Expected instance --state-dir DIR --json");
      const observed = await inspectInstancePublication(resolve(values["state-dir"]));
      if (observed === "unconfirmed")
        throw Error("Writer present or inaccessible; ownership unconfirmed");
      console.log(JSON.stringify(observed === "stopped" ? null : observed));
    } else if (command === "daemon") {
      const { values } = parseArgs({
        args,
        options: {
          "state-dir": { type: "string" },
          listen: { type: "string" },
          port: { type: "string" },
          "tls-cert": { type: "string" },
          "tls-key": { type: "string" },
          "public-origin": { type: "string" },
        },
      });
      if (!values["state-dir"] || !values.listen || !values.port || !/^\d+$/.test(values.port))
        throw new Error("Expected daemon --state-dir DIR --listen 127.0.0.1 --port N");
      const listener = await listenBrowserDaemon(values["state-dir"], {
        host: values.listen,
        port: Number(values.port),
        ...(values["tls-cert"] !== undefined ? { certificate: values["tls-cert"] } : {}),
        ...(values["tls-key"] !== undefined ? { privateKey: values["tls-key"] } : {}),
        ...(values["public-origin"] !== undefined ? { publicOrigin: values["public-origin"] } : {}),
      });
      process.once("SIGTERM", listener.shutdown);
      process.once("SIGINT", listener.shutdown);
      process.stdout.write(`${JSON.stringify(listener.ready)}\n`);
    } else if (command === "identity" || command === "start") {
      const parsed = parseInstalledCommand(command, args);
      if (parsed.kind === "identity") {
        const signal = AbortSignal.timeout(90_000);
        const publication = await readInstancePublication(parsed.stateDir);
        if (!publication) throw Error("Environment is unavailable");
        process.stdout.write(
          JSON.stringify(
            await identityCommand(publication.environmentId, publication.endpoint, signal),
          ) + "\n",
        );
      } else if (parsed.kind === "foreground")
        await startForeground(parsed.stateDir, parsed.action);
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
    } else if (command === "access") await accessCli(args);
    else if (command === "replay") await replay(args);
    else throw new Error("Unknown command, expected start, identity, access, daemon or replay");
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}

export { listenIdentity, type IdentityPort } from "./identity";
