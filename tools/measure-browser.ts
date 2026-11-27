import { join } from "node:path";
import * as v from "valibot";
import type { CommandId, CommandReceipt } from "@kraka/protocol";
import { openReceiptReader, readReceipt, readThread } from "@kraka/environment";
import { openDeviceCredentials } from "../packages/cli-client/src";
import { openAccessHost } from "../packages/daemon/src/access";
import type { RouteDial } from "../packages/client-runtime/src";
import type { ReportBase } from "./perf";
import { certificate } from "./fixtures/browser-cert";
import { currentFootprint, noChildren } from "./measure-replay";
import { within, withState, terminate } from "./fixtures/replay-process";
import { connectDevice, commandId } from "./fixtures/paired-project";
import { startFirstSendFixture, accepted } from "./fixtures/first-send";

export function tlsDial(ca: string, starts: Map<string, number>): RouteDial {
  return (url, receive) => {
    const ws = new WebSocket(url, { tls: { ca } });
    ws.onmessage = (e) => receive({ kind: "frame", value: JSON.parse(String(e.data)) });
    ws.onclose = (e) => receive({ kind: "closed", code: e.code });
    ws.onerror = () => receive({ kind: "closed" });
    return {
      close: (code) => ws.close(code),
      send(frame) {
        const json = JSON.stringify(frame);
        if ("commandId" in frame && typeof frame.commandId === "string")
          starts.set(frame.commandId, performance.now());
        ws.send(json);
      },
    };
  };
}
async function launch(root: string, state: string, tls: Awaited<ReturnType<typeof certificate>>) {
  const start = performance.now();
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "packages/daemon/src/index.ts"),
      "daemon",
      "--state-dir",
      state,
      "--listen",
      "127.0.0.1",
      "--port",
      "0",
      "--tls-cert",
      tls.cert,
      "--tls-key",
      tls.key,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  try {
    const first = await within(child.stdout.getReader().read(), 8000, "TLS listener ready");
    const ready = v.parse(
      v.object({ kind: v.literal("ready"), origin: v.string() }),
      JSON.parse(new TextDecoder().decode(first.value)),
    );
    if (!ready.origin.startsWith("https://127.0.0.1:")) throw Error("Expected loopback TLS");
    return { child, start, origin: ready.origin };
  } catch (e) {
    await terminate(child);
    throw e;
  }
}
async function trusted(state: string, deviceDir: string) {
  const device = await openDeviceCredentials(join(deviceDir, "device.sqlite"));
  const host = await openAccessHost(state, {
    present: async () => true,
    approve: async () => true,
  });
  try {
    if (!host.store.device(device.deviceId)) {
      const confirmed = await host.trusted.confirm({
        kind: "bootstrap",
        environment: host.identity,
        deviceId: device.deviceId,
        keyId: device.keyId,
        publicKey: device.publicKey,
      });
      if (confirmed !== "registered") throw Error("Owner bootstrap denied");
    }
    const grant = host.store.device(device.deviceId);
    if (!grant) throw Error("Missing registered benchmark device");
    return { identity: host.identity, principal: grant.principal, device };
  } catch (e) {
    device.close();
    throw e;
  } finally {
    host.close();
  }
}
export async function measureBrowser(
  base: ReportBase,
  root: string,
  metric: "P1" | "P2" | "P9",
  nextBlock: () => Promise<void>,
) {
  const idle = metric === "P2";
  if (metric === "P9") return rename(base, root, nextBlock);
  const counts = { launches: 0, accepted: 0, joined: 0 };
  base.actual = counts;
  const n = idle ? 10 : 20;
  base.expected = { launches: n, accepted: n, joined: n };
  await withState(async (certificates) => {
    const tls = await certificate(certificates);
    for (let pair = 0; pair < 10; pair++) {
      await withState(async (dir) => {
        const state = join(dir, "daemon"),
          clientDir = join(dir, "client");
        let firstDevice: string | undefined;
        for (const series of idle ? ["idle"] : ["fresh", "reused"]) {
          const app = await launch(root, state, tls);
          counts.launches++;
          try {
            const owner = await trusted(state, clientDir);
            try {
              if (series === "reused" && firstDevice !== owner.device.deviceId)
                throw Error("Registration changed");
              firstDevice = owner.device.deviceId;
              const client = await connectDevice(
                app.origin,
                owner.identity,
                owner.device,
                owner.principal,
                tlsDial(tls.ca, new Map()),
              );
              try {
                const id = commandId(),
                  r = await client.request({
                    commandId: id,
                    method: "access.listSessions",
                    payload: {},
                  });
                const at = performance.now();
                if (
                  r.kind !== "accepted" ||
                  r.commandId !== id ||
                  r.result.kind !== "sessionsListed" ||
                  r.result.sessions[0]?.connectionId !== client.configuration.connectionId ||
                  !r.result.sessions.some((s) => s.principal.id === owner.principal.id)
                )
                  throw Error("Missing signed launch acceptance");
                counts.accepted++;
                const trace = {
                  pair,
                  series,
                  method: "access.listSessions",
                  commandId: id,
                  device: owner.device.deviceId,
                  environment: owner.identity.id,
                };
                if (idle) {
                  // This fresh access-only directory has no thread or executor workload.
                  noChildren(app.child.pid);
                  await Bun.sleep(Math.max(0, at + 60000 - performance.now()));
                  if (app.child.exitCode !== null || app.child.signalCode !== null)
                    throw Error("Idle PID exited");
                  noChildren(app.child.pid);
                  const memory = await currentFootprint(app.child.pid);
                  base.samples.push({ series, unit: "MiB", value: memory.mib });
                  base.observations.push({ ...trace, ...memory, pid: app.child.pid });
                } else {
                  base.samples.push({ series, unit: "ms", value: at - app.start });
                  base.observations.push({ ...trace, ms: at - app.start });
                }
              } finally {
                client.close();
              }
            } finally {
              owner.device.close();
            }
          } finally {
            await terminate(app.child);
            counts.joined++;
          }
        }
      });
      await nextBlock();
    }
  });
  return idle ? { idle: 10 } : { fresh: 10, reused: 10 };
}
async function rename(base: ReportBase, root: string, nextBlock: () => Promise<void>) {
  const counts = { single: 0, eight: 0, warmups: 0, reopened: 0, refusals: 0, retries: 0 };
  base.actual = counts;
  base.expected = {
    single: 1250,
    eight: 4000,
    warmups: 250,
    reopened: 5500,
    refusals: 0,
    retries: 0,
  };
  await withState(async (dir) => {
    const tls = await certificate(dir),
      state = join(dir, "writer");
    const seed = await startFirstSendFixture({
      stateDir: state,
      projectDirectory: join(dir, "project"),
      root,
      adapter: "replay",
    });
    const thread = await (async () => {
      try {
        return accepted((await seed.send()).receipt, "threadStarted").threadId;
      } finally {
        await seed.close();
      }
    })();
    const app = await launch(root, state, tls);
    try {
      const owner = await trusted(state, join(dir, "device"));
      const clients: Awaited<ReturnType<typeof connectDevice>>[] = [];
      try {
        const starts = new Map<string, number>();
        for (let i = 0; i < 8; i++)
          clients.push(
            await connectDevice(
              app.origin,
              owner.identity,
              owner.device,
              owner.principal,
              tlsDial(tls.ca, starts),
            ),
          );
        const matched = new Map<
          string,
          { id: CommandId; title: string; receipt: CommandReceipt }
        >();
        let ordinal = 0;
        async function batch(
          c: (typeof clients)[number],
          series: "single" | "eight",
          length: number,
          warmups: number,
        ) {
          for (let i = 0; i < length; i++) {
            const id = commandId(),
              title = `TLS rename ${++ordinal}`;
            const receipt = await c.request({
              commandId: id,
              method: "thread.rename",
              payload: { threadId: thread, title },
            });
            const stop = performance.now(),
              start = starts.get(id);
            if (receipt.kind !== "accepted") {
              counts.refusals++;
              throw Error("Rename refused");
            }
            if (
              receipt.commandId !== id ||
              receipt.result.kind !== "threadRenamed" ||
              receipt.result.threadId !== thread ||
              start === undefined ||
              matched.has(receipt.result.version)
            )
              throw Error("Missing or duplicate rename");
            matched.set(receipt.result.version, { id, title, receipt });
            if (i < warmups) counts.warmups++;
            else {
              counts[series]++;
              base.samples.push({ series, unit: "ms", value: stop - start });
            }
          }
        }
        const first = clients[0];
        if (!first) throw Error("No TLS writers");
        for (let i = 0; i < 5; i++) {
          await batch(first, "single", 300, 50);
          await nextBlock();
        }
        for (let i = 0; i < 5; i++) {
          await Promise.all(clients.map((c) => batch(c, "eight", 100, 0)));
          await nextBlock();
        }
        const db = openReceiptReader(state);
        try {
          for (let version = 2; version <= 5501; version++) {
            const item = matched.get(String(version));
            if (!item) throw Error("Missing committed version");
            const row = readReceipt(db, owner.principal.id, item.id);
            if (
              !row ||
              !Bun.deepEquals(row.receipt, item.receipt) ||
              JSON.parse(row.intent).payload.title !== item.title
            )
              throw Error("Durable rename mismatch");
            counts.reopened++;
          }
          const last = readThread(db, thread);
          if (last?.title !== matched.get("5501")?.title || last?.version !== "5501")
            throw Error("Final thread mismatch");
          base.observations.push({
            environment: owner.identity.id,
            device: owner.device.deviceId,
            thread,
            version: last.version,
          });
        } finally {
          db.close();
        }
      } finally {
        for (const c of clients) c.close();
        owner.device.close();
      }
    } finally {
      await terminate(app.child);
    }
  });
  return { single: 1250, eight: 4000 };
}
