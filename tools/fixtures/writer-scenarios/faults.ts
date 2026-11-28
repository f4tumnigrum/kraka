import type { Scenario } from "./fixture";
import { Worker } from "node:worker_threads";
import { existsSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
export const faults: Scenario = ({ state, root, point, adapter }) => {
  function barrier(name: string, data = "entered") {
    if (point !== name) return;
    const marker = join(state, `entered-${name}`);
    if (existsSync(marker)) return;
    writeFileSync(marker + ".tmp", data, { flag: "wx" });
    renameSync(marker + ".tmp", marker);
    const path = join(state, `release-${name}`);
    const signal = new Int32Array(new SharedArrayBuffer(4));
    const worker = new Worker(new URL("../barrier-worker.ts", import.meta.url), {
      workerData: { path, signal },
    });
    try {
      Atomics.wait(signal, 0, 0);
      if (Atomics.load(signal, 0) !== 1) throw Error("Missing " + path);
    } finally {
      void worker.terminate();
    }
  }
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
        if (!Bun.deepEquals(native.frames.shift(), expected))
          throw new Error("Peer event mismatch");
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
  return {
    lifecycle: {
      preparation(point, managed) {
        barrier(point, JSON.stringify(managed));
      },
      locked() {
        barrier("locked");
      },
      opened(store) {
        store.beforeCommit = (method) => {
          if (method === "thread.start") barrier("beforeCommit");
        };
      },
      committed(req) {
        if (req.method === "thread.start") barrier("afterCommit");
      },
      update(event) {
        if (point === "peer" && event.kind === "round.started") {
          const path = join(state, `started-${event.roundId}`);
          writeFileSync(path + ".tmp", JSON.stringify(event));
          renameSync(path + ".tmp", path);
        }
      },
    },
  };
};
