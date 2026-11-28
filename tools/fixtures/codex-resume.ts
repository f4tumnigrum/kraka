import { seedGit } from "./isolated-start";
import type { CheckpointCapture, Round } from "@kraka/protocol";
import assert from "node:assert/strict";
import { join } from "node:path";
import * as v from "valibot";
import {
  type ExecutorTurnUpdate,
  type TodoRequest,
  type ThreadId,
  type PermissionMode,
} from "@kraka/protocol";

import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { startPairedProject } from "./paired-project";
import { connectReplica } from "./thread-resume";
import { codexFixture } from "./codex-turn";
import { connectFirstSend } from "./first-send-client";
import { accepted, launchWriter, productRoot } from "./first-send";
import { Journal, dispatchObservationMs } from "./route-network";
import { within, withState } from "./replay-process";
const observation = v.looseObject({
  event: v.string(),
  epoch: v.number(),
  handle: v.number(),
  session: v.string(),
  root: v.string(),
});
const stageSchema = v.object({
  stage: v.picklist(["sealed", "published", "summary", "settled"]),
  boundary: v.picklist(["before", "after"]),
  id: v.string(),
  thread: v.string(),
  round: v.string(),
  token: v.string(),
});
export class CaptureBarriers {
  readonly events = new Journal<v.InferOutput<typeof stageSchema>>();
  hold: v.InferOutput<typeof stageSchema>["stage"] | null = null;
  failSummary = false;
  writer?: ReturnType<typeof launchWriter>;
  receive = (raw: unknown) => {
    const e = v.parse(stageSchema, raw);
    this.events.push(e);
    if (e.boundary !== "after" || e.stage !== this.hold)
      this.release(e.token, e.stage === "summary" && this.failSummary);
  };
  release(token: string, fail = false) {
    this.writer?.child.send({ token, fail });
  }
}
async function setup(
  dir: string,
  mode: PermissionMode,
  root: string,
  patch?: { git: boolean; barriers: CaptureBarriers },
) {
  const events = new Journal<v.InferOutput<typeof observation>>(),
    updates = new Journal<ExecutorTurnUpdate>();
  const peers = new Map<number, Bun.ServerWebSocket<null>>();
  const disconnects = new Map<
    Bun.ServerWebSocket<null>,
    ReturnType<typeof Promise.withResolvers<void>>
  >();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req, { data: null })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      data: null as null,
      open(ws) {
        disconnects.set(ws, Promise.withResolvers<void>());
      },
      close(ws) {
        disconnects.get(ws)?.resolve();
        disconnects.delete(ws);
      },
      message(ws, raw) {
        const row = v.parse(observation, JSON.parse(String(raw)));
        peers.set(row.handle, ws);
        events.push(row);
      },
    },
  });
  const clean: (() => unknown | Promise<unknown>)[] = [];
  async function close() {
    try {
      const errors: unknown[] = [];
      for (const fn of clean.splice(0).reverse()) {
        try {
          await fn();
        } catch (e) {
          errors.push(e);
        }
      }
      await within(
        Promise.all([...disconnects.values()].map((x) => x.promise)),
        5000,
        "Native peers closed",
      );
      if (errors.length) throw new AggregateError(errors, "Codex fixture cleanup failed");
    } finally {
      await server.stop(true);
    }
  }
  try {
    const pair = await startPairedProject({
      stateDir: dir,
      projectId: "setup-project",
      requests: [],
    });
    clean.push(pair.close);
    const state = join(pair.stateDir, "host");
    if (patch?.git) seedGit(dir, "project");
    const f = await codexFixture(
      dir,
      {
        control: "ws://127.0.0.1:" + server.port,
        ...(patch ? { capture: patch.barriers.receive, historyDirectory: dir } : {}),
      },
      root,
      !!patch,
      undefined,
      state,
      (e) => updates.push(e),
    );
    const writers = [f.stderrTail];
    if (patch) patch.barriers.writer = f;
    clean.push(f.close);
    const reg = structuredClone(f.registration);
    reg.permission = { ceiling: mode, selected: mode };
    accepted((await f.configure(null, reg)).receipt, "executorConfigured");
    const refresh = accepted((await f.refresh()).receipt, "executorRefreshed");
    assert.equal(refresh.snapshot?.matrix.resumeSessionAfterHostRestart.kind, "native");
    let client = f.client,
      endpoint = f.instance.endpoint;
    const event = (name: string, since = 0) =>
      events.until(
        (e) => e.event === name,
        since,
        name === "turn" ? dispatchObservationMs : undefined,
      );
    const action = (handle: number, cmd: string) => {
      const ws = peers.get(handle);
      if (!ws || ws.send(cmd) <= 0) throw Error("Missing native peer " + handle);
    };
    const cache = new SqliteThreadCache(join(dir, "device.sqlite"), "device");
    clean.push(() => cache.close());
    let last: import("@kraka/protocol").SyncCursor | null = null;
    async function replica(threadId: ThreadId) {
      const todos = new Journal<TodoRequest>();
      const rounds = new Journal<import("@kraka/protocol").Round>();
      const socket = await connectReplica(endpoint, pair.identity, pair.owner, cache, {
        minor: 1,
        installed(head) {
          last = head;
          for (const row of Object.values(cache.read().rows))
            if (row.row?.objectType === "todoRequest") todos.push(row.row.value);
            else if (row.row?.objectType === "round") rounds.push(row.row.value);
        },
      });
      clean.push(socket.close);
      const sub = await socket.client.open(threadId, last);
      assert.equal((await sub.receipt).kind, "accepted");
      return { rpc: socket.client.rpc.bind(socket.client), todos, rounds, close: socket.close };
    }
    async function start(text: string) {
      const since = events.items.length;
      const ids = accepted(
        (
          await client.send("thread.start", {
            ...f.payload,
            content: { ...f.payload.content, text },
          })
        ).receipt,
        "threadStarted",
      );
      const turn = await event("turn", since);
      const start = await updates.untilDispatch(
        (e) => e.kind === "round.started" && e.attemptId === ids.attemptId,
      );
      assert.ok(
        start.kind === "round.started" &&
          start.selectedMode === mode &&
          start.effectiveMode === mode,
      );
      assert.equal(
        start.effectivePolicy?.sandbox.type,
        mode === "ask" ? "readOnly" : mode === "edits" ? "workspaceWrite" : "dangerFullAccess",
      );
      return { ...ids, turn };
    }
    async function acknowledgedStop(threadId: ThreadId, stopCommandId: string) {
      const deadline = performance.now() + 5000;
      do {
        const reply = await client.send("round.readStop", { threadId, stopCommandId });
        const record = accepted(reply.receipt, "stopResult");
        if (record.reachedAt !== null) return record;
      } while (performance.now() < deadline);
      throw Error(`No committed interrupt acknowledgement for ${stopCommandId}`);
    }
    async function restart(abrupt = false) {
      client.close();
      if (abrupt) await f.kill();
      else await f.stop();
      const next = launchWriter(state, root, patch ? "codex" : "codex-cli");
      writers.push(next.stderrTail);
      clean.push(next.stop);
      const { publication: instance } = await next.ready();
      endpoint = instance.endpoint;
      client = await connectFirstSend(state, instance, (e) => updates.push(e));
      clean.push(client.close);
      return next.started;
    }
    return {
      f,
      stderrTails: () => writers.map((tail) => tail()),
      async patchReader(threadId: ThreadId, directoryDiff = true) {
        const cache = new SqliteThreadCache(
          join(dir, crypto.randomUUID() + ".sqlite"),
          "patch-reader",
        );
        clean.push(() => cache.close());
        const snapshots = new Journal<{ rounds: Round[]; captures: CheckpointCapture[] }>();
        const socket = await connectReplica(endpoint, pair.identity, pair.owner, cache, {
          minor: 1,
          directoryDiff,
          installed() {
            const rows = Object.values(cache.read().rows).map((r) => r.row);
            snapshots.push({
              rounds: rows.flatMap((r) => (r?.objectType === "round" ? [r.value] : [])),
              captures: rows.flatMap((r) =>
                r?.objectType === "checkpointCapture" ? [r.value] : [],
              ),
            });
          },
        });
        clean.push(socket.close);
        assert.equal((await (await socket.client.open(threadId, null)).receipt).kind, "accepted");
        return {
          snapshots,
          read: (query: import("@kraka/protocol").DiffRequest, cursor: string | null = null) =>
            socket.client.rpc("checkpoint.diff", { query, cursor }),
          close: socket.close,
        };
      },
      events,
      updates,
      action,
      event,
      start,
      replica,
      acknowledgedStop,
      close,
      restart,
      get client() {
        return client;
      },
      state,
      input: (threadId: ThreadId, text: string) =>
        client.send("input.send", { threadId, content: { text, attachments: [], references: [] } }),
    };
  } catch (e) {
    await close();
    throw e;
  }
}
type Setup = Awaited<ReturnType<typeof setup>>;
export function runCodexCase(
  mode: PermissionMode,
  fn: (s: Setup) => Promise<void>,
  root = productRoot,
  patch?: { git: boolean; barriers: CaptureBarriers },
) {
  return withState(async (dir) => {
    const s = await setup(dir, mode, root, patch);
    try {
      await fn(s);
    } finally {
      await s.close();
    }
  });
}
