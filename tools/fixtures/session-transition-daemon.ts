import { join } from "node:path";
import * as v from "valibot";
import { readThread, type FirstSendStore, type LocalActor } from "@kraka/environment";
import { startWriter } from "../../packages/daemon/src/first-send";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { startPairedProject } from "./paired-project";
import { connectFirstSend } from "./first-send-client";
import { connectReplica } from "./thread-resume";
import { configureLocalOwner, accepted } from "./first-send";
import { within, withState } from "./replay-process";
import { peerFamily } from "./transition-family";
import { stateSchema, proposal, type PeerState } from "./transition-host";
import { seedTransition, command, tid } from "./transition-store";

async function launchPeer(dir: string, name: string) {
  const ready = Promise.withResolvers<void>(),
    pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, "transition-peer.ts"), dir, name],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc(raw: unknown) {
        const m = v.parse(
          v.object({
            v: v.literal(1),
            ready: v.optional(v.boolean()),
            id: v.optional(v.string()),
            error: v.optional(v.string()),
            value: v.optional(v.unknown()),
          }),
          raw,
        );
        if (m.ready) ready.resolve();
        if (m.id) {
          const waiter = pending.get(m.id);
          if (m.error) waiter?.reject(Error(m.error));
          else waiter?.resolve(m.value);
          pending.delete(m.id);
        }
      },
    },
  );
  void child.exited.then((code) => {
    const err = Error(name + " exited " + code);
    ready.reject(err);
    for (const p of pending.values()) p.reject(err);
  });
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.disconnect();
    await child.exited;
  }
  try {
    await within(ready.promise, 10000, "peer ready");
  } catch (e) {
    await close();
    throw e;
  }
  return {
    close,
    async call(call: object) {
      const id = crypto.randomUUID(),
        r = Promise.withResolvers<unknown>();
      pending.set(id, r);
      try {
        child.send({ v: 1, id, call });
        return await within(r.promise, 10000, "peer acknowledgement");
      } finally {
        pending.delete(id);
      }
    },
  };
}
export async function withSessionDaemon<T>(
  run: (s: Awaited<ReturnType<typeof setup>>) => Promise<T>,
) {
  return withState(async (dir) => {
    const fixture = await setup(dir);
    try {
      return await run(fixture);
    } finally {
      await fixture.close();
    }
  });
}
async function setup(dir: string) {
  const peers = new Map<string, Awaited<ReturnType<typeof launchPeer>>>();
  const states = new Map<string, PeerState>();
  const clean: (() => Promise<void>)[] = [];
  const close = async () => {
    for (const f of clean.splice(0).reverse()) await f();
  };
  try {
    const call = (id: string, body: object) => {
      const peer = peers.get(id);
      if (!peer) throw Error("Missing peer");
      return peer.call(body);
    };
    for (const name of ["alpha", "beta"]) {
      const peer = await launchPeer(dir, name);
      peers.set(name, peer);
      clean.push(peer.close);
      states.set(name, v.parse(stateSchema, await peer.call({ kind: "declare" })));
    }
    const pairing = await startPairedProject({ stateDir: dir, projectId: "fixture", requests: [] });
    clean.push(pairing.close);
    const stateDir = join(pairing.stateDir, "host");
    await configureLocalOwner(stateDir);
    let store!: FirstSendStore;
    const cache = new SqliteThreadCache(join(dir, "replica.sqlite"), "S33");
    clean.push(async () => cache.close());
    async function open() {
      const w = await startWriter(stateDir, null, {
        families: [peerFamily(call)],
        opened(s) {
          store = s;
          const actor: LocalActor = {
            environmentId: s.writer.environmentId,
            id: pairing.owner.principal.id,
            allows: () => true,
          };
          seedTransition(s, dir, actor);
          for (const peer of states.values())
            s.db.run("INSERT OR IGNORE INTO executor_registrations VALUES(?,?)", [
              peer.instance,
              JSON.stringify({
                family: "codex",
                instanceId: peer.instance,
                version: String(peer.revision),
                displayName: peer.instance,
                enabled: true,
                driver: {
                  endpoint: null,
                  executable: null,
                  configurationRoot: null,
                  historyRoot: null,
                  variables: {},
                },
                credential: null,
                model: { id: peer.model, options: {} },
                permission: { ceiling: "ask", selected: "ask" },
              }),
            ]);
          s.db.run("INSERT OR IGNORE INTO round_executors VALUES('round-R','alpha','1',?)", [
            JSON.stringify({ id: "model-alpha", options: {} }),
          ]);
        },
      });
      if (w.kind !== "ready") throw Error("Missing writer");
      try {
        const conn = await connectReplica(
          w.instance.endpoint,
          pairing.identity,
          pairing.owner,
          cache,
          { minor: 2 },
        );
        const refresh = async (instance: string) => {
          const client = await connectFirstSend(stateDir, w.instance);
          try {
            accepted(
              (
                await client.send("executor.refresh", {
                  projectId: readThread(store.db, tid)?.projectId,
                  instanceId: instance,
                })
              ).receipt,
              "executorRefreshed",
            );
          } finally {
            client.close();
          }
        };
        for (const name of states.keys()) await refresh(name);
        return {
          refresh,
          conn,
          async close() {
            await conn.close();
            await w.close();
          },
        };
      } catch (e) {
        await w.close();
        throw e;
      }
    }
    let daemon = await open();
    clean.push(() => daemon.close());
    return {
      close,
      get store() {
        return store;
      },
      get client() {
        return daemon.conn.client;
      },
      async restart() {
        await daemon.close();
        daemon = await open();
      },
      async revise(instance: string, patch: object) {
        states.set(
          instance,
          v.parse(stateSchema, await call(instance, { kind: "revise", ...patch })),
        );
        store.db.run(
          "UPDATE executor_registrations SET data=json_set(data,\x27$.version\x27,?) WHERE id=?",
          [String(states.get(instance)?.revision), instance],
        );
        await daemon.refresh(instance);
      },
      async waitForInput(instance: string) {
        await call(instance, { kind: "waitInput" });
      },
      async ledger(instance: string) {
        return v.parse(
          v.array(v.record(v.string(), v.unknown())),
          await call(instance, { kind: "fence" }),
        );
      },
      async preview(payload = proposal()) {
        return accepted(
          await daemon.conn.client.rpc("thread.previewSession", payload),
          "sessionTransitionPreview",
        ).preview;
      },
      async switch(id: string, op = "switch") {
        return daemon.conn.client.rpc("thread.switchSession", { previewId: id }, command(op));
      },
      async read(op = "switch") {
        return accepted(
          await daemon.conn.client.rpc("thread.readSessionTransition", {
            threadId: tid,
            operationId: command(op),
          }),
          "sessionTransition",
        ).transition;
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
