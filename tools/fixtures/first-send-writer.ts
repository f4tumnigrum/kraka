import { scenarioInput, serveSeed } from "./thread-seed";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { startWriter } from "../../packages/daemon/src/first-send";
import * as v from "valibot";
import { fixture } from "./replay-process";
const [stateDir, root, point] = process.argv.slice(2);
if (!stateDir || !root) throw new Error("Expected state and product roots");
const state = stateDir;
function barrier(name: string) {
  if (point !== name) return;
  const marker = join(state, `entered-${name}`);
  if (existsSync(marker)) return;
  writeFileSync(marker, "entered", { flag: "wx" });
  while (!existsSync(join(state, `release-${name}`))) Bun.sleepSync(5);
}
const recording = parseReplayRecording(readFileSync(join(root, fixture), "utf8"));
const adapter = createReplayAdapter(recording);
if (point === "peer" || point === "externalWrite") {
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
const writer = await startWriter(
  state,
  { adapter, expectedText: recording.expectedText, modelId: recording.modelId },
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
    locked() {
      barrier("locked");
    },
    opened(store) {
      if (point === "resume") serveSeed(store, state);
      store.beforeCommit = (method) => {
        if (method === "thread.start") barrier("beforeCommit");
      };
    },
    committed(req) {
      if (req.method === "thread.start") barrier("afterCommit");
    },
    update(event) {
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
