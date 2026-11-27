import { settingPeer } from "./setting-peer";
import { scenarioInput, serveSeed } from "./thread-seed";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { type FirstSendStore, readMessage, readReceipt, readRound } from "@kraka/environment";
import {
  CommandIdSchema,
  ExecutorInstanceIdSchema,
  HandoffContextSchema,
  PrincipalIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import { startWriter } from "../../packages/daemon/src/first-send";
import { attachPeer } from "./input-adapter";
import { fixture } from "./replay-process";
import { runWorktreeWorker, worktreeWorkerCommand } from "@kraka/environment";
if (process.argv[2] === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}

const [stateDir, root, point] = process.argv.slice(2);
if (!stateDir || !root) throw new Error("Expected state and product roots");
const state = stateDir;
function barrier(name: string, data = "entered") {
  if (point !== name) return;
  const marker = join(state, `entered-${name}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, data, { flag: "wx" });
  while (!existsSync(join(state, `release-${name}`))) Bun.sleepSync(5);
}
const recording = parseReplayRecording(readFileSync(join(root, fixture), "utf8"));
const adapter = createReplayAdapter(recording);
if (
  point === "peer" ||
  point === "externalWrite" ||
  ["claimed", "registered", "beforeSetup", "setupExited"].includes(point ?? "")
) {
  const open = adapter.open,
    invoke = adapter.invoke;
  const sessions = new WeakMap<object, { cwd: string; frames: unknown[] }>();
  const events = adapter.events;
  adapter.events = async function* (session, after) {
    const native = sessions.get(session.handle);
    if (!native) throw new Error("Unknown replay session");
    for await (const expected of events(session, after)) {
      if (!Bun.deepEquals(native.frames.shift(), expected)) throw new Error("Peer event mismatch");
      yield expected;
    }
    if (native.frames.length) throw new Error("Unexpected peer events");
  };
  adapter.open = async (input) => {
    const opened = await open(input);
    if (opened.kind === "ok")
      sessions.set(opened.value.handle, { cwd: input.setup.workingDirectory, frames: [] });
    return opened;
  };
  // The peer consumes the actual delivery in the directory handed to the adapter.
  adapter.invoke = (async (...args: Parameters<typeof invoke>) => {
    const command = args[2];
    if (command.kind === "deliverInput") {
      const native = sessions.get(args[0].handle);
      if (!native) throw new Error("Unknown delivery session");
      const peer = Bun.spawnSync(
        [
          process.execPath,
          join(root, "tools/fixtures/first-send-peer.ts"),
          join(state, `peer-${command.deliveryId}`),
          root,
        ],
        {
          cwd: native.cwd,
          stdin: Buffer.from(JSON.stringify(command)),
          stdout: "pipe",
          stderr: "pipe",
          timeout: 5000,
        },
      );
      if (peer.exitCode !== 0) throw new Error(peer.stderr.toString());
      native.frames = v.parse(v.array(v.unknown()), JSON.parse(peer.stdout.toString()));
      barrier("externalWrite");
    }
    return invoke(...args);
  }) as typeof invoke;
}
let openedStore: FirstSendStore | undefined;
const waitForClaim = point === "recovery" ? attachPeer(adapter, state) : undefined;
const recover = point === "recovery" && existsSync(join(state, "dedup"));
const writer = await startWriter(
  state,
  {
    adapter,
    expectedText: recording.expectedText,
    modelId: recording.modelId,
    ...(recover
      ? {
          recovery: {
            binding: {
              family: "replay" as const,
              instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
              nativeSessionId: recording.nativeSessionId,
              epoch: 1,
            },
            input: {
              receipt: "proof" as const,
              deduplicate: "acrossRestart" as const,
              query: "none" as const,
            },
          },
        }
      : {}),
  },
  {
    ...(point === "resume"
      ? {
          threadCommand: scenarioInput,
          inspectPage(page: import("@kraka/protocol").SubscriptionPage) {
            if (!existsSync(join(state, "unknown-change"))) return page;
            return JSON.parse(
              JSON.stringify({ ...page, changes: [{ kind: "future.required" }, ...page.changes] }),
            );
          },
        }
      : {}),
    ...(point === "settings"
      ? {
          settingReply: settingPeer(state, () => {
            if (!openedStore) throw Error("Writer not open");
            return openedStore;
          }),
        }
      : {}),
    preparation(point, managed) {
      barrier(point, JSON.stringify(managed));
    },
    async beforeDispatch(threadId) {
      if (point === "settings" && openedStore) {
        process.send?.({ event: "dispatch", threadId });
      }
      if (waitForClaim) await waitForClaim();
      if (point === "recovery" && openedStore && existsSync(join(state, "seed-handoff"))) {
        const input = JSON.parse(readFileSync(join(state, "seed-handoff"), "utf8"));
        const round = readRound(openedStore.db, input.roundId);
        const message = round && readMessage(openedStore.db, round.messageId);
        if (!round || !message) throw Error("Missing handoff source");
        openedStore.freeze({
          attemptId: round.attempt.attemptId,
          deliveryId: round.attempt.deliveryId,
          target: {
            family: "replay",
            instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
            nativeSessionId: recording.nativeSessionId,
            epoch: 1,
          },
          messageVersion: message.version,
          input: {
            id: message.id,
            text: message.text,
            attachments: message.attachments,
            references: message.references,
          },
          parts: [],
          handoff: v.parse(HandoffContextSchema, input.handoff),
        });
        rmSync(join(state, "seed-handoff"));
      }
    },
    locked() {
      barrier("locked");
    },
    opened(store) {
      if (point === "resume") serveSeed(store);
      openedStore = store;
      store.beforeCommit = (method) => {
        const marker = join(state, "auto-row");
        if (point === "recovery" && method === "input.send" && existsSync(marker)) {
          const row = readReceipt(
            store.db,
            v.parse(PrincipalIdSchema, "first-send-local-owner"),
            v.parse(CommandIdSchema, "second"),
          );
          const result = row?.receipt.kind === "accepted" ? row.receipt.result : null;
          if (result?.kind !== "inputScheduled") throw Error("Missing automatic input fixture");
          store.db.run("UPDATE rounds SET source='automation' WHERE id=?", [result.roundId]);
          store.db.run("UPDATE messages SET data=json_set(data,'$.author',json(?)) WHERE id=?", [
            JSON.stringify({ kind: "executor", id: readFileSync(marker, "utf8") }),
            result.messageId,
          ]);
          store.db.run("INSERT INTO input_guarantees VALUES(?,?)", [
            result.deliveryId,
            JSON.stringify({
              binding: {
                family: "replay",
                instanceId: "replay",
                nativeSessionId: recording.nativeSessionId,
                epoch: 1,
              },
              input: { receipt: "proof", deduplicate: "acrossRestart", query: "none" },
            }),
          ]);
          rmSync(marker);
        }
        if (method === "thread.start") barrier("beforeCommit");
      };
    },
    committed(req, receipt) {
      if (
        point === "recovery" &&
        existsSync(join(state, "lose-" + req.commandId)) &&
        receipt.kind === "accepted"
      )
        return "disconnect";
      if (req.method === "thread.start") barrier("afterCommit");
    },
    update(event) {
      if (point === "settings" && event.kind === "round.ended")
        process.send?.({ event: "ended", roundId: event.roundId });
      if (point === "peer" && event.kind === "round.started")
        writeFileSync(join(state, `started-${event.roundId}`), JSON.stringify(event));
    },
  },
);
if (writer.kind === "unconfirmed") throw new Error(writer.reason);
if (writer.kind === "ready") {
  process.once("SIGTERM", writer.close);
  process.once("SIGINT", writer.close);
}
console.log(JSON.stringify({ kind: writer.kind, instance: writer.instance }));
