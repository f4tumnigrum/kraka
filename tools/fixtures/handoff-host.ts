import { join, basename } from "node:path";
import { copyFile, cp } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import * as v from "valibot";
import {
  ExecutorInstanceIdSchema,
  ProjectIdSchema,
  DEFAULT_DEVICE_PERMISSIONS,
  SyncCursorSchema,
  HistoryPageSchema,
  TodoReplyRecordSchema,
  EnvironmentIdSchema,
  DeviceIdSchema,
  ThreadIdSchema,
  SubscriptionIdSchema,
} from "@kraka/protocol";
import type { InstalledThread } from "../../packages/client-runtime/hosts/native-thread";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import { installedDirectory, startInstalled, pairingRecord } from "./installed";
import { commandId, connectDevice, beginApplication, invite, approve } from "./paired-project";
import { buildPeer } from "./codex-turn";
import { accepted, productRoot } from "./first-send";
import { Journal, dispatchObservationMs } from "./route-network";
import { terminate } from "./replay-process";

export const installedRecord = v.strictObject({
  kind: v.literal("installed"),
  environmentId: EnvironmentIdSchema,
  threadId: ThreadIdSchema,
  deviceId: DeviceIdSchema,
  connectionId: v.string(),
  subscriptionId: SubscriptionIdSchema,
  after: v.nullable(SyncCursorSchema),
  head: SyncCursorSchema,
  rows: HistoryPageSchema.entries.rows,
  answers: v.array(TodoReplyRecordSchema),
});
export type Site = Awaited<ReturnType<typeof installedDirectory>>;
const nativeEvent = v.object({
  event: v.string(),
  handle: v.number(),
  id: v.optional(v.union([v.number(), v.string()])),
  session: v.string(),
  root: v.string(),
  text: v.optional(v.string()),
  result: v.optional(v.unknown()),
});
export async function handoffHost(site: Site, dir: string, publicOrigin?: string) {
  const peers = new Map<number, Bun.ServerWebSocket<null>>();
  const events = new Journal<v.InferOutput<typeof nativeEvent>>();
  const control = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req, { data: null })) return;
      return new Response(null, { status: 404 });
    },
    websocket: {
      data: null as null,
      message(ws, wire) {
        const e = v.parse(nativeEvent, JSON.parse(String(wire)));
        peers.set(e.handle, ws);
        events.push(e);
      },
    },
  });
  const stop: (() => void | Promise<void>)[] = [
    async () => {
      await control.stop(true);
    },
  ];
  async function close() {
    for (const f of stop.splice(0).reverse()) await f();
  }
  try {
    const daemon = startInstalled({
      ...site,
      env: { ...site.env, ...(publicOrigin ? { KRAKA_BROWSER_ORIGIN: publicOrigin } : {}) },
    });
    stop.push(daemon.close);
    const publication = await daemon.ready(),
      pairing = await daemon.next(pairingRecord);
    const { identity, principal } = await daemon.register(),
      url = new URL(pairing.url);
    const projectId = v.parse(
      ProjectIdSchema,
      new URLSearchParams(url.hash.slice(1)).get("projectId"),
    );
    const key = await openDeviceCredentials(join(site.client, "device.sqlite"));
    stop.push(key.close);
    const owner = await connectDevice(url.origin, identity, key, principal);
    stop.push(owner.close);
    const exe = await buildPeer(dir),
      name = basename(exe);
    await copyFile(exe, join(site.cwd, name));
    const recordings = join(productRoot, "fixtures/executors/codex");
    await cp(recordings, site.cwd, { recursive: true });
    await copyFile(join(recordings, "basic-turn.jsonl"), join(site.cwd, "frames"));
    const instanceId = v.parse(ExecutorInstanceIdSchema, "peer");
    accepted(
      await owner.request({
        method: "executor.configure",
        commandId: commandId(),
        payload: {
          expectedVersion: null,
          registration: {
            family: "codex",
            instanceId,
            displayName: "Peer",
            enabled: true,
            driver: {
              executable: "./" + name,
              endpoint: null,
              configurationRoot: null,
              historyRoot: null,
              variables: {
                PEER_CONTROL: { kind: "literal", value: "ws://127.0.0.1:" + control.port },
              },
            },
            credential: null,
            model: null,
            permission: { selected: "ask", ceiling: "edits" },
          },
        },
      }),
      "executorConfigured",
    );
    accepted(
      await owner.request({
        method: "executor.refresh",
        commandId: commandId(),
        payload: { projectId, instanceId },
      }),
      "executorRefreshed",
    );
    const initial = accepted(
      await owner.request({
        method: "thread.start",
        commandId: commandId(),
        payload: {
          projectId,
          worktreeId: null,
          content: { text: "resume", references: [], attachments: [] },
        },
      }),
      "threadStarted",
    );
    const event = (name: string, since = 0) =>
      events.until((x) => x.event === name, since, dispatchObservationMs);
    const turn = await event("turn");
    return {
      identity,
      projectId,
      owner,
      inviteId: pairing.inviteId,
      nextHostRecord: daemon.next,
      publication,
      initial,
      turn,
      events,
      event,
      close,
      control(e: { handle: number }, action: string) {
        const ws = peers.get(e.handle);
        if (!ws || ws.send(action) <= 0) throw Error("Native peer unavailable");
      },
      async pairProfile(profileDir: string) {
        const device = await openDeviceCredentials(join(profileDir, "device.sqlite"));
        try {
          const app = await beginApplication(
            device,
            url.origin,
            identity,
            projectId,
            await invite(owner, projectId),
            [...DEFAULT_DEVICE_PERMISSIONS],
          );
          try {
            await approve(owner, app.pending);
            app.socket.send(await app.proof());
            return app.finish(await app.socket.result());
          } finally {
            app.socket.close();
          }
        } finally {
          device.close();
        }
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export function installedFollow(site: Site, threadId: InstalledThread["threadId"]) {
  const child = Bun.spawn(
    [site.bin, "thread", "follow", "--state-dir", site.state, "--thread", threadId, "--jsonl"],
    { cwd: site.cwd, env: site.env, stdout: "pipe", stderr: "pipe" },
  );
  const records = new Journal<InstalledThread>(),
    lines = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity });
  const errors = new Response(child.stderr).text();
  const done = (async () => {
    for await (const line of lines) records.push(v.parse(installedRecord, JSON.parse(line)));
    throw Error("Follow exited (" + (await child.exited) + "): " + (await errors));
  })();
  void done.catch(() => {});
  return {
    records,
    at: (predicate: (r: InstalledThread) => boolean) =>
      Promise.race([records.until(predicate, 0, dispatchObservationMs), done]),
    async close() {
      await terminate(child, () => child.kill("SIGINT"));
      lines.close();
      await done.catch(() => {});
    },
  };
}
