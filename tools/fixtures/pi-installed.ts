import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  ControlStream,
  decodeFrame,
  ControlMessageSchema,
  ExecutorInstanceIdSchema,
  type ThreadId,
  type TodoRequestId,
} from "@kraka/protocol";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { connectDevice, commandId } from "./paired-project";
import { accepted } from "./first-send";
import { connectReplica } from "./thread-resume";
import {
  disposableRelease,
  hostRelease,
  pairingRecord,
  startInstalled,
  runIdentity,
} from "./installed";
import { Journal } from "./route-network";

import type { RouteDial } from "../../packages/client-runtime/src";
import { utf8 } from "../../packages/daemon/src/flow-socket";
const flowDial: RouteDial = (url, receive) => {
  const socket = new WebSocket(url, "kraka.flow.v1");
  socket.binaryType = "arraybuffer";
  let stream: ControlStream | undefined,
    configured = false;
  socket.onmessage = (e) => {
    const wire = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
    if (!stream) {
      const first = decodeFrame(wire, utf8);
      if (first.lane !== "control" || first.message.kind !== "server.hello")
        throw Error("Missing installed flow hello");
      stream = new ControlStream(
        first.epoch,
        {
          utf8,
          now: performance.now.bind(performance),
          write(data) {
            socket.send(data);
            return 1;
          },
        },
        () => configured,
        (msg) => {
          if (msg.kind === "session.configuration") configured = true;
          receive({ kind: "frame", value: msg });
        },
      );
    }
    stream.input(wire);
  };
  socket.onclose = (e) => {
    stream?.close();
    receive({ kind: "closed", code: e.code });
  };
  return {
    send(value) {
      if (!stream) throw Error("Missing flow stream");
      stream.send(v.parse(ControlMessageSchema, value));
    },
    close: () => socket.terminate(),
  };
};
const frame = v.looseObject({ type: v.string(), id: v.string() });
const signal = v.looseObject({
  event: v.string(),
  pid: v.number(),
  epoch: v.number(),
  frame: v.optional(frame),
  id: v.optional(v.string()),
  position: v.optional(v.number()),
});
async function openFixture(
  site: Parameters<typeof startInstalled>[0],
  dir: string,
  executable: string,
  hold: ReadonlySet<string>,
) {
  const signals = new Journal<v.InferOutput<typeof signal>>();
  const gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  for (const key of hold) gates.set(key, Promise.withResolvers<void>());
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const row = v.parse(signal, await request.json());
      signals.push(row);
      await gates.get(row.event)?.promise;
      return new Response(null, { status: 204 });
    },
  });
  const daemon = startInstalled(site, "--print-pairing");
  const cleanup: (() => void | Promise<void>)[] = [() => server.stop(true), () => daemon.close()];
  async function close() {
    for (const gate of gates.values()) gate.resolve();
    const failures: unknown[] = [];
    for (const release of cleanup.splice(0).reverse())
      try {
        await release();
      } catch (error) {
        failures.push(error);
      }
    if (failures.length) throw new AggregateError(failures, "Pi fixture cleanup");
  }
  try {
    const publication = await daemon.ready(),
      pair = await daemon.next(pairingRecord);
    if (pair.environmentId !== publication.environmentId)
      throw Error("Unmatched installed pairing record");
    const { identity, principal } = await daemon.register();
    const device = await openDeviceCredentials(join(site.client, "device.sqlite"));
    cleanup.push(device.close);
    const client = await connectDevice(
      new URL(pair.url).origin,
      identity,
      device,
      principal,
      flowDial,
    );
    cleanup.push(client.close);
    async function request(input: Parameters<typeof client.request>[0]) {
      try {
        return await client.request(input);
      } catch (error) {
        throw Error(
          `${input.method} failed (last route event ${client.events.items.at(-1)?.kind}, daemon ${daemon.stderrTail()})`,
          { cause: error },
        );
      }
    }
    const project = accepted(
      await request({
        method: "project.register",
        commandId: commandId(),
        payload: { realPath: site.cwd },
      }),
      "projectRegistered",
    ).project;
    const account = join(dir, "account"),
      sessions = join(dir, "sessions"),
      ledger = join(dir, "pi-native.jsonl");
    await Promise.all([mkdir(account), mkdir(sessions)]);
    const instanceId = v.parse(ExecutorInstanceIdSchema, "installed-pi");
    const registration = {
      family: "pi" as const,
      instanceId,
      displayName: "Pi RPC fixture",
      enabled: true,
      credential: null,
      model: { id: "sample-provider/sample-chat", options: {} },
      permission: { selected: "ask", ceiling: "edits" } as const,
      driver: {
        executable,
        configurationRoot: account,
        historyRoot: sessions,
        endpoint: null,
        variables: {
          KRAKA_PI_LEDGER: { kind: "literal" as const, value: ledger },
          KRAKA_PI_CONTROL: { kind: "literal" as const, value: server.url.href },
        },
      },
    };
    accepted(
      await request({
        method: "executor.configure",
        commandId: commandId(),
        payload: { expectedVersion: null, registration },
      }),
      "executorConfigured",
    );
    const refreshed = accepted(
      await request({
        method: "executor.refresh",
        commandId: commandId(),
        payload: { projectId: project.id, instanceId },
      }),
      "executorRefreshed",
    );
    if (!refreshed.snapshot || refreshed.readiness.operation.state !== "yes")
      throw Error(`Pi probe unavailable: ${JSON.stringify(refreshed)}`);
    async function connect(threadId: ThreadId) {
      const cache = new SqliteThreadCache(join(dir, `${crypto.randomUUID()}.sqlite`), "pi");
      cleanup.push(() => cache.close());
      const socket = await connectReplica(publication.endpoint, identity, client, cache, {
        minor: 2,
        installedProtocol: true,
      });
      cleanup.push(() => socket.close());
      const opened = await socket.client.open(threadId, null);
      if ((await opened.receipt).kind !== "accepted") throw Error("Thread subscription failed");
      await socket.until(() => socket.heads.length > 0, "initial Pi thread");
      const rows = () => Object.values(cache.read().rows).flatMap((r) => (r.row ? [r.row] : []));
      const rounds = () => rows().flatMap((r) => (r.objectType === "round" ? [r.value] : []));
      const todos = () => rows().flatMap((r) => (r.objectType === "todoRequest" ? [r.value] : []));
      async function question(nativeId: string) {
        const find = () =>
          todos().find(
            (t) =>
              t.state.kind === "open" &&
              t.state.route.kind === "live" &&
              t.state.route.requestId === nativeId,
          );
        await socket.until(() => !!find(), `Pi question ${nativeId}`);
        const item = find();
        if (!item) throw Error("Lost Pi question");
        return item;
      }
      return {
        ...socket,
        rows,
        rounds,
        todos,
        question,
        answer: (todoRequestId: TodoRequestId, nativeId: string, value: string) =>
          socket.client.rpc("todo.answer", {
            threadId,
            todoRequestId,
            answers: [{ questionKey: nativeId, answer: value }],
          }),
        async send(text: string) {
          return accepted(
            await socket.client.rpc("input.send", {
              threadId,
              content: { text, attachments: [], references: [] },
            }),
            "inputScheduled",
          );
        },
        async history() {
          const head = socket.heads.at(-1);
          if (!head) throw Error("Missing thread cursor");
          return socket.client.history(head, null, () => true);
        },
      };
    }
    return {
      close,
      connect,
      refreshed,
      project,
      site,
      principal,
      device: device.deviceId,
      dir,
      registration,
      checkIdentity: () => runIdentity(site),
      rows: async () =>
        (await readFile(ledger, "utf8"))
          .trimEnd()
          .split("\n")
          .map((s) => v.parse(signal, JSON.parse(s))),
      release: (name: string) => gates.get(name)?.resolve(),
      wait: (event: string, epoch: number) =>
        signals.until((row) => row.event === event && row.epoch === epoch, 0, 12_000),
      async start(text: string) {
        return accepted(
          await request({
            method: "thread.start",
            commandId: commandId(),
            payload: {
              projectId: project.id,
              worktreeId: null,
              instanceId,
              model: registration.model,
              content: { text, references: [], attachments: [] },
            },
          }),
          "threadStarted",
        );
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
export type InstalledPi = Awaited<ReturnType<typeof openFixture>>;
export async function withInstalledPi(
  artifact: Awaited<ReturnType<typeof hostRelease>>,
  peer: string,
  hold: string[],
  run: (f: InstalledPi) => Promise<void>,
) {
  await disposableRelease(artifact, async (site, dir) => {
    const fixture = await openFixture(site, dir, peer, new Set(hold));
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}
