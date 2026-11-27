import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  commandSchema,
  entrySchema,
  type PeerEntry,
  type PeerCommand,
  type turnAction,
} from "./input-peer-control";

const [state, ...holds] = process.argv.slice(2);
if (!state || !process.send) throw Error("Expected private input peer channel and directory");
const send = process.send.bind(process);
const journal = join(state, "peer.jsonl");
const dedup = join(state, "dedup");
const held = new Set(holds);
const rows: PeerEntry[] = [];
const actions = new Map<string, v.InferOutput<typeof turnAction>[]>();
const pickedUp = new Set<string>();
let changed = Promise.withResolvers<void>();
function notify() {
  const previous = changed;
  changed = Promise.withResolvers<void>();
  previous.resolve();
}
function queueAction(attempt: string, action: v.InferOutput<typeof turnAction>) {
  const pending = actions.get(attempt) ?? [];
  pending.push(action);
  actions.set(attempt, pending);
  notify();
}
function append(item: PeerEntry, step: string) {
  const row = { ...item, step };
  appendFileSync(journal, JSON.stringify(row) + "\n");
  rows.push(row);
  notify();
}
async function waitGate(step: string) {
  while (held.has(step)) await changed.promise;
}
async function control(cmd: PeerCommand) {
  switch (cmd.kind) {
    case "ledger":
      return rows;
    case "seen":
      for (;;) {
        const row = rows.find((r) => r.step === cmd.step && r.deliveryId === cmd.deliveryId);
        if (row) return [row];
        await changed.promise;
      }
    case "hold":
      held.add(cmd.step);
      break;
    case "release":
      held.delete(cmd.step);
      break;
    case "releaseAll":
      held.clear();
      break;
    case "late":
      queueAction(cmd.attemptId, { kind: "late", source: cmd.source });
      break;
  }
  notify();
  return [];
}
process.on("message", async (message: unknown) => {
  const { id, command } = v.parse(v.object({ id: v.string(), command: commandSchema }), message);
  send({ kind: "reply", id, rows: await control(command) });
});
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    if (path === "/claim") {
      await waitGate("claim");
      return new Response(null, { status: 204 });
    }
    const item = v.parse(entrySchema, await req.json());
    if (path === "/turn") {
      while (held.has("turn")) {
        const action = actions.get(item.attemptId)?.shift();
        if (action) return Response.json(action);
        await changed.promise;
      }
      return Response.json({ kind: "resume" });
    }
    async function observe(step: string) {
      append(item, step);
      await waitGate(step);
    }
    if (item.step === "write") {
      await observe("beforeWrite");
      const key = JSON.stringify([item.attemptId, item.deliveryId]);
      if (!existsSync(dedup) || !pickedUp.has(key)) {
        pickedUp.add(key);
        append(item, "externalEffect");
      }
      await observe("afterWrite");
      await observe("receipt");
    } else {
      await observe(item.step);
      if (item.step === "steer")
        queueAction(item.attemptId, {
          kind: "steer",
          messageId: item.messageId,
          deliveryId: item.deliveryId,
        });
    }
    return Response.json({ sessionId: item.sessionId, itemId: "native-" + item.deliveryId });
  },
});
send({ kind: "ready", origin: server.url.origin });
process.once("SIGTERM", () => {
  void server.stop(true);
  process.exit(0);
});
