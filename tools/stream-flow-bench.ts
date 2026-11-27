import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import type { FlowPeer, FrameSink, WireMessage } from "@kraka/protocol";
import {
  CommandIdSchema,
  ConnectionIdSchema,
  ContentTransferIdSchema,
  SignedRequestSchema,
  SubscriptionIdSchema,
} from "@kraka/protocol";
import { withState, within } from "./fixtures/replay-process";
import { fixtureSession } from "./fixtures/flow-session";

type Direction = "upload" | "download";
type Shape = "loopback" | "delay" | "bandwidth";
const here = resolve(import.meta.dir, "..");
const epoch = v.parse(ConnectionIdSchema, "transfer-epoch");
const transferId = v.parse(ContentTransferIdSchema, "generated");
const subId = v.parse(SubscriptionIdSchema, "transfer");
const template = v.parse(SignedRequestSchema, {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "studio",
  connectionId: epoch,
  challengeId: "challenge",
  challenge: "a".repeat(43),
  signer: { kind: "device", deviceId: "bench", keyId: "fixture-key" },
  sequence: 1,
  commandId: "sample",
  method: "access.listSessions",
  payload: {},
  signature: "a".repeat(86),
});

function generated(offset: number, length: number) {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    const position = offset + i;
    bytes[i] = (position * 31 + (position >>> 8)) & 255;
  }
  return bytes;
}
function expectedDigest(bytes: number) {
  const hash = new Bun.CryptoHasher("sha256");
  for (let i = 0; i < bytes; i += 65536) hash.update(generated(i, Math.min(65536, bytes - i)));
  return hash.digest("hex");
}
const digests = new Map<number, string>();

class Link {
  private free = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly queue: { at: number; action: () => void }[] = [];
  constructor(private shape: Shape) {}
  submit(size: number, action: () => void) {
    if (this.shape === "loopback") {
      action();
      return;
    }
    this.free =
      Math.max(performance.now(), this.free) +
      (this.shape === "bandwidth" ? (size * 1000) / 8000 : 0);
    this.queue.push({ at: this.free + (this.shape === "delay" ? 50 : 0), action });
    if (!this.timer) this.arm();
  }
  private arm() {
    const first = this.queue[0];
    if (!first) return;
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        while (this.queue[0] && this.queue[0].at <= performance.now()) this.queue.shift()?.action();
        this.arm();
      },
      Math.max(1, first.at - performance.now()),
    );
  }
  close() {
    clearTimeout(this.timer);
    this.queue.length = 0;
  }
}

async function modules(root: string) {
  const load = (path: string) => import(pathToFileURL(join(root, path)).href);
  const protocol: typeof import("@kraka/protocol") = await load("packages/protocol/src/index.ts");
  const daemon: typeof import("../packages/daemon/src/flow-socket") = await load(
    "packages/daemon/src/flow-socket.ts",
  );
  return { protocol, daemon };
}

export async function transfer(root: string, direction: Direction, total: number, shape: Shape) {
  const { protocol, daemon } = await modules(root);
  const digest = digests.get(total) ?? expectedDigest(total);
  digests.set(total, digest);
  return withState(async (stateDir) => {
    let serverPeer: FlowPeer | undefined;
    let wake = () => {};
    const up = new Link(shape),
      down = new Link(shape);
    const completed = Promise.withResolvers<void>();
    const configured = Promise.withResolvers<void>();
    const pending = new Map<string, number>();
    const receiptsMs: number[] = [],
      labels: string[] = [];
    let sent = 0,
      bytes = 0,
      elapsedMs = 0,
      started = 0,
      stopping = false,
      falseDisconnects = 0;
    let pingSent = 0,
      pingSerial = 0,
      pong = 0;
    const hash = new Bun.CryptoHasher("sha256");
    function sink(get: () => FlowPeer, server: boolean): FrameSink {
      return {
        control(m) {
          const peer = get();
          if (!server && m.kind === "session.authorized") return;
          if (!server && m.kind === "session.configuration") {
            configured.resolve();
            return;
          }
          if (server && m.kind === "signedRequest" && m.method === "access.listSessions")
            peer.control({
              kind: "accepted",
              commandId: m.commandId,
              result: { kind: "sessionsListed", sessions: [] },
            });
          else if (!server && m.kind === "accepted" && m.result.kind === "sessionsListed") {
            const at = pending.get(m.commandId);
            if (at === undefined) throw new Error("Unmatched control receipt");
            labels.push(m.commandId);
            receiptsMs.push(performance.now() - at);
            pending.delete(m.commandId);
          } else if (m.kind === "transport.probe")
            peer.control({ kind: "transport.echo", serial: m.serial });
          else if (m.kind === "transport.echo" && m.serial === pingSerial) pong = m.serial;
          else throw new Error("Unexpected control response");
          if (bytes === total && !pending.size) completed.resolve();
        },
        data(frame, size) {
          if (!("payload" in frame)) throw new Error("Expected binary content");
          bytes += frame.payload.length;
          hash.update(frame.payload);
          get().control(get().receive.consume(frame.streamId, size));
          if (bytes === total) {
            elapsedMs = performance.now() - started;
            if (!pending.size) completed.resolve();
          }
        },
        discarded() {
          completed.reject(new Error("Invalid transfer"));
        },
      };
    }
    const server = await daemon.listenFlow({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      application: () => ({
        epoch,
        attach(peer, kick) {
          serverPeer = peer;
          wake = kick;
          const session = fixtureSession("bench", epoch, "fixture-key");
          peer.control(session.authorized);
          peer.control(session.configuration);
          return {
            ...sink(() => peer, true),
            close() {
              if (!stopping) {
                falseDisconnects++;
                completed.reject(new Error("Server disconnected"));
              }
            },
          };
        },
      }),
    });
    const socket = new WebSocket(`${server.ready.origin.replace("http:", "ws:")}/ws`);
    const opened = Promise.withResolvers<void>();
    socket.binaryType = "arraybuffer";
    const client: FlowPeer = new protocol.FlowPeer(
      epoch,
      {
        utf8: daemon.utf8,
        now: () => performance.now(),
        write(data) {
          up.submit(protocol.wireBytes(data, daemon.utf8), () => {
            if (!stopping) socket.send(data);
          });
          return 1;
        },
      },
      sink(() => client, false),
    );
    socket.onopen = () => opened.resolve();
    socket.onerror = () => {
      opened.reject(new Error("Socket error"));
      completed.reject(new Error("Socket error"));
    };
    socket.onclose = () => {
      if (!stopping) {
        falseDisconnects++;
        completed.reject(new Error("Client disconnected"));
      }
    };
    socket.onmessage = (event) => {
      const data: WireMessage =
        typeof event.data === "string" ? event.data : new Uint8Array(event.data);
      down.submit(protocol.wireBytes(data, daemon.utf8), () => {
        try {
          client.input(data);
          client.pump();
        } catch (e) {
          completed.reject(e);
        }
      });
    };
    let timer: ReturnType<typeof setInterval> | undefined;
    try {
      await within(opened.promise, 5000, "open transfer socket");
      await within(configured.promise, 5000, "configure transfer socket");
      if (!serverPeer) throw new Error("Missing server session");
      const sender = direction === "upload" ? client : serverPeer,
        receiver = direction === "upload" ? serverPeer : client;
      receiver.receive.open(1);
      receiver.receive.declare(1, transferId, total);
      sender.send.open(
        subId,
        protocol.binarySource({
          epoch,
          streamId: 1,
          transferId,
          length: total,
          read: generated,
          utf8: daemon.utf8,
        }),
      );
      started = performance.now();
      const interval = shape === "loopback" ? 20 : 1000;
      timer = setInterval(() => {
        try {
          if (!bytes || bytes === total) return;
          const now = performance.now();
          if (pingSerial !== pong && now - pingSent >= 15000)
            throw new Error("Heartbeat expired during transfer");
          if (now - pingSent >= 5000 && pingSerial === pong) {
            pingSent = now;
            client.control({ kind: "transport.probe", serial: ++pingSerial });
          }
          const sequence = ++sent;
          const commandId = v.parse(CommandIdSchema, `${direction}-${sequence}`);
          pending.set(commandId, now);
          client.control({ ...template, commandId, sequence });
          client.pump();
        } catch (e) {
          completed.reject(e);
        }
      }, interval);
      if (direction === "upload") client.pump();
      else wake();
      await within(
        completed.promise,
        shape === "bandwidth" ? 250000 : 90000,
        "transfer and receipts",
      );
      const actualDigest = hash.digest("hex");
      if (
        bytes !== total ||
        actualDigest !== digest ||
        !sent ||
        sent !== receiptsMs.length ||
        falseDisconnects
      )
        throw new Error("Incomplete transfer or receipt set");
      if (shape !== "loopback" && receiptsMs.some((ms) => ms > 2000))
        throw new Error("Shaped receipt exceeded 2 seconds");
      return {
        direction,
        shape,
        bytes,
        digest: actualDigest,
        elapsedMs,
        bytesPerSecond: (bytes * 1000) / elapsedMs,
        sent,
        labels,
        receiptsMs,
        falseDisconnects,
      };
    } finally {
      stopping = true;
      clearInterval(timer);
      up.close();
      down.close();
      client.close();
      socket.terminate();
      await server.shutdown();
    }
  });
}
export async function* sampleTransfers(root: string) {
  for (let trial = 0; trial < 10; trial++)
    for (const direction of ["download", "upload"] as const)
      yield { ...(await transfer(root, direction, 20_000_000, "loopback")), trial: trial + 1 };
}
if (import.meta.main) {
  if (Bun.argv.slice(2).join() !== "--shaped") throw new Error("Expected --shaped");
  for (const shape of ["delay", "bandwidth"] as const)
    console.log(JSON.stringify(await transfer(here, "download", 1_000_000, shape)));
  console.log(JSON.stringify({ group: 4, completed: true }));
}
