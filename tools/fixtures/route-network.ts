import { CAPTURE_BOUNDARY_TIMEOUT_MS } from "../../packages/environment/src/checkpoints";
import { join, resolve } from "node:path";
import * as v from "valibot";
import {
  DevicePrincipalSchema,
  RequestSignerSchema,
  EnvironmentIdentitySchema,
  RouteSchema,
  type EnvironmentIdentity,
  base64url,
} from "@kraka/protocol";
import { signP256 } from "@kraka/protocol/web-crypto";
import { terminate, within } from "./replay-process";

const observationMs = 7000;
// S16 records a before boundary prior to delivery. Dispatch gets the original observation margin plus one capture.
export const dispatchObservationMs = observationMs + CAPTURE_BOUNDARY_TIMEOUT_MS;
export class Journal<T> {
  readonly items: T[] = [];
  private changed = Promise.withResolvers<void>();
  push(item: T) {
    this.items.push(item);
    this.changed.resolve();
    this.changed = Promise.withResolvers<void>();
  }
  untilDispatch(predicate: (item: T) => boolean, since = 0) {
    return this.until(predicate, since, dispatchObservationMs);
  }
  async until(predicate: (item: T) => boolean, since = 0, budgetMs?: number) {
    const deadline = budgetMs === undefined ? null : performance.now() + budgetMs;
    for (;;) {
      const match = this.items.slice(since).find(predicate);
      if (match !== undefined) return match;
      await within(
        this.changed.promise,
        deadline === null ? observationMs : Math.max(0, deadline - performance.now()),
        "Route observation",
      );
    }
  }
}

export async function deviceHost() {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const calls: string[] = [];
  const signer = v.parse(RequestSignerSchema, { kind: "device", deviceId: "dev", keyId: "key" });
  if (signer.kind !== "device") throw Error("Invalid fixture signer");
  const principal = v.parse(DevicePrincipalSchema, {
    kind: "device",
    id: "principal",
    deviceId: "dev",
    ownerId: "owner",
  });
  return {
    publicKey,
    calls,
    credentials: (identity: EnvironmentIdentity) => ({
      signer,
      principal,
      identity,
      sign(text: string) {
        calls.push(text);
        return signP256(keys.privateKey, text);
      },
    }),
  };
}
export async function startPeer(dir: string, id: string, publicKey: string, state = "usable") {
  const child = Bun.spawn(
    [process.execPath, resolve("tools/fixtures/route-daemon.ts"), id, publicKey, state],
    { cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const error = new Response(child.stderr).text();
  const ready = Promise.withResolvers<string>();
  const drained = (async () => {
    let line = "";
    for await (const chunk of child.stdout) {
      line += Buffer.from(chunk).toString();
      if (line.includes("\n")) ready.resolve(line.trim());
    }
    if (!line.includes("\n")) ready.reject(Error(`Peer exited: ${await error}`));
  })();
  void drained.catch(ready.reject);
  const stop = async () => {
    await terminate(child);
    await Promise.all([drained, error]);
  };
  try {
    const result = v.parse(
      v.strictObject({ origin: v.string(), identity: EnvironmentIdentitySchema }),
      JSON.parse(await within(ready.promise, 6000, "Identity daemon ready")),
    );
    return { ...result, stop };
  } catch (e) {
    await stop();
    throw e;
  }
}
type Traffic = {
  nonce: string;
  auth: number;
  commands: string[];
  incoming: unknown[];
  closed: boolean;
};
type ProxyConnection = { target: string; upstream: WebSocket | null; record: Traffic };
export function pathTo(origin: string) {
  let target = origin;
  const peers = new Set<Bun.ServerWebSocket<ProxyConnection>>();
  const records: Traffic[] = [];
  let hold: "server.hello" | "session.configuration" | null = null;
  const held: Array<() => void> = [];
  const frames = new Journal<{ kind: string; frame: unknown }>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url);
      const nonce = url.searchParams.get("nonce");
      if (!nonce || url.pathname !== "/ws") return new Response(null, { status: 400 });
      const record: Traffic = { nonce, auth: 0, commands: [], incoming: [], closed: false };
      records.push(record);
      if (
        srv.upgrade(req, {
          data: {
            target: target.replace(/^http/, "ws") + url.pathname + url.search,
            upstream: null,
            record,
          },
        })
      )
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      data: {} as ProxyConnection,
      open(ws) {
        peers.add(ws);
        const peer = new WebSocket(ws.data.target);
        ws.data.upstream = peer;
        peer.onmessage = ({ data }) => {
          const frame = JSON.parse(String(data));
          ws.data.record.incoming.push(frame);
          frames.push({ kind: frame.kind, frame });
          const deliver = () => {
            if (!ws.data.record.closed) ws.send(String(data));
          };
          if (frame.kind === hold) held.push(deliver);
          else deliver();
        };
        peer.onclose = () => ws.close();
        peer.onerror = () => ws.close();
      },
      message(ws, data) {
        const frame = JSON.parse(String(data));
        if (frame.kind === "client.authenticate") ws.data.record.auth++;
        if (frame.kind === "signedRequest") ws.data.record.commands.push(frame.commandId);
        ws.data.upstream?.send(String(data));
      },
      close(ws) {
        ws.data.record.closed = true;
        peers.delete(ws);
        ws.data.upstream?.terminate();
      },
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    records,
    frames,
    point(at: string) {
      target = at;
    },
    hold(kind: "server.hello" | "session.configuration") {
      hold = kind;
    },
    release() {
      hold = null;
      for (const deliver of held.splice(0)) deliver();
    },
    cut() {
      for (const peer of peers) peer.terminate();
    },
    async stop() {
      for (const peer of peers) {
        peer.data.upstream?.terminate();
        peer.terminate();
      }
      await server.stop(true);
    },
  };
}
export function route(pin: EnvironmentIdentity, id: string, endpoint: string) {
  return v.parse(RouteSchema, {
    id,
    kind: "lan",
    endpoint,
    environmentId: pin.id,
    status: { kind: "untested" },
  });
}
export function closedOrigin() {
  const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
  const origin = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return origin;
}
export const directoryPath = (dir: string, name: string) => join(dir, `${name}.sqlite`);
