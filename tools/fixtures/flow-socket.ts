import { observation } from "./observation";
import { join } from "node:path";
import * as v from "valibot";
import { SubscriptionSession } from "../../packages/client-runtime/src/subscription-session";
import { listenFlow, utf8, type SocketApplication } from "../../packages/daemon/src/flow-socket";
import { SubscriptionWriter } from "../../packages/daemon/src/subscription-writer";
import {
  ControlMessageSchema,
  SignedRequestSchema,
  decodeFrame,
  type CommandReceipt,
  type ControlMessage,
  type FlowPeer,
  type SignedRequest,
  type SubscriptionPage,
  type SyncCursor,
  type WireMessage,
} from "@kraka/protocol";
import { referenceCompiler } from "../reference-client";
import { fixtureSession } from "./flow-session";
import { within, withState } from "./replay-process";
import { parseScenario } from "./scenario";

const root = join(import.meta.dir, "../..");
export const slow = parseScenario(
  await Bun.file(
    join(root, "fixtures/scenarios/a-slow-subscription-does-not-stall-its-neighbor.json"),
  ).json(),
);
const named = referenceCompiler(
  await Bun.file(join(root, "docs/generated/protocol/protocol.schema.json")).json(),
);
const header = named("TransportFrameHeader"),
  logicalPage = named("SubscriptionPage");
export function inspect(data: WireMessage) {
  const frame = decodeFrame(data, utf8);
  const fields = "payload" in frame ? (({ payload, ...rest }) => rest)(frame) : frame;
  if (!header(fields))
    throw new Error(`Invalid generated TransportFrameHeader: ${JSON.stringify(header.errors)}`);
  return frame;
}
type Listener = (request: SignedRequest, remote: Remote) => void;
export type Remote = {
  peer: FlowPeer;
  wake: () => void;
  writers: Map<number, SubscriptionWriter>;
  respond: (
    request: SignedRequest,
    result: Extract<CommandReceipt, { kind: "accepted" }>["result"],
  ) => void;
};
export class Gate {
  private readonly waiting = Promise.withResolvers<void>();
  private held = true;
  readonly armed = () => within(this.waiting.promise, 4000, `arm write gate ${this.kind}`);
  constructor(readonly kind: string) {}
  block(kind: string) {
    if (this.held && this.kind === kind) {
      this.waiting.resolve();
      return true;
    }
    return false;
  }
  release(remote: Remote) {
    this.held = false;
    remote.peer.drain();
    remote.wake();
  }
}
export async function flowFixture<T>(
  body: (fixture: {
    connect: (
      device: string,
      opts?: Parameters<typeof connectSocket>[4],
    ) => ReturnType<typeof connectSocket>;
  }) => Promise<T>,
) {
  return withState(async (stateDir) => {
    const apps: SocketApplication[] = [];
    const cleanups: (() => void)[] = [];
    const listener = await listenFlow({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      application: () => apps.shift() ?? null,
    });
    try {
      return await body({
        connect: (device, opts = {}) =>
          connectSocket(listener.ready.origin, apps, cleanups, device, opts),
      });
    } finally {
      for (const close of cleanups) close();
      await listener.shutdown();
    }
  });
}
async function connectSocket(
  origin: string,
  apps: SocketApplication[],
  cleanups: (() => void)[],
  device: string,
  opts: {
    gates?: Gate[];
    holdCredit?: number;
    epoch?: string;
    dispatch?: Listener;
    installed?: (p: readonly SubscriptionPage[], h: SyncCursor) => void;
    deferOpen?: boolean;
  },
) {
  const endpoint = slow.clients.find((c) => c.deviceId === device)?.connections[0];
  if (!endpoint) throw new Error(`No fixture endpoint for ${device}`);
  const session = fixtureSession(device, opts.epoch ?? endpoint.connectionId);
  const epoch = session.hello.connectionId;
  const observed = observation();
  let dispatches = 0,
    creditHeld = opts.holdCredit;
  let remote: Remote | undefined;
  const opened = Promise.withResolvers<void>();
  let error: unknown;
  const messages: (ControlMessage | SubscriptionPage)[] = [];
  const openRequests: SignedRequest[] = [];
  const writers = new Map<number, SubscriptionWriter>();
  apps.push({
    epoch,
    write(data, send) {
      const frame = inspect(data);
      const kind = frame.lane === "window" ? "window" : frame.message.kind;
      if (opts.gates?.some((g) => g.block(kind))) return 0;
      return send(data);
    },
    attach(peer, wake) {
      const connection: Remote = {
        peer,
        wake,
        writers,
        respond: (r, result) => {
          peer.control({ kind: "accepted", commandId: r.commandId, result });
          wake();
        },
      };
      remote = connection;
      peer.control(session.authorized);
      peer.control(session.configuration);
      return {
        control(m) {
          if (m.kind !== "signedRequest") return;
          dispatches++;
          observed.changed();
          if (m.method === "subscription.openThread") {
            const writer = new SubscriptionWriter(peer, m.payload.subscriptionId, wake);
            if (writer.id !== m.payload.streamId) throw new Error("Wrong stream proposal");
            writers.set(writer.id, writer);
            openRequests.push(m);
            if (!opts.deferOpen)
              connection.respond(m, {
                kind: "subscriptionOpened",
                streamId: writer.id,
                subscriptionId: m.payload.subscriptionId,
              });
          } else {
            const request = v.parse(SignedRequestSchema, m);
            if (opts.dispatch) opts.dispatch(request, connection);
            else connection.respond(request, { kind: "actionAccepted" });
          }
        },
        data() {
          throw new Error("Unexpected upload");
        },
        discarded() {},
        close() {
          writers.clear();
        },
      };
    },
  });
  const socket = new WebSocket(`${origin.replace("http:", "ws:")}/ws`);
  socket.binaryType = "arraybuffer";
  const client = new SubscriptionSession(
    session.hello,
    {
      principal: session.authorized.principal,
      signer: session.authorized.signer,
      features: session.hello.features,
      protocolVersion: session.hello.protocolVersion,
    },
    {
      utf8,
      now: () => performance.now(),
      write(data) {
        inspect(data);
        socket.send(data);
        return 1;
      },
    },
    (pages, head) => {
      for (const page of pages) {
        if (!logicalPage(page)) throw Error("Invalid generated SubscriptionPage");
        messages.push(page);
      }
      opts.installed?.(pages, head);
    },
    (id, size) => (id === creditHeld ? 0 : size),
  );
  socket.onopen = () => opened.resolve();
  socket.onmessage = (e) => {
    try {
      const data: WireMessage = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      const frame = inspect(data);
      client.peer.input(data);
      if (
        frame.lane === "control" &&
        !["transport.content", "session.configuration", "session.authorized"].includes(
          frame.message.kind,
        )
      )
        messages.push(frame.message);
      client.peer.pump();
    } catch (e) {
      error = e;
      socket.terminate();
    } finally {
      observed.changed();
    }
  };
  socket.onclose = () => {
    client.close();
  };
  socket.onerror = () => opened.reject(new Error("Socket failed"));
  cleanups.push(() => {
    client.close();
    socket.terminate();
  });
  await within(opened.promise, 4000, "open socket");
  if (!remote) throw Error("Socket has no endpoint");
  const server = remote;
  return {
    client,
    remote: server,
    session,
    messages,
    openRequests,
    dispatches: () => dispatches,
    wait: (p: () => boolean, label: string, ms?: number) =>
      observed.until(
        () => {
          if (error) throw error;
          return p();
        },
        label,
        ms ?? 4000,
      ),
    open(id: number, after?: SyncCursor) {
      const info = endpoint.subscriptions.find((s) => s.streamId === id);
      if (info?.kind !== "objects" || !info.installed || info.installed.scope.kind !== "thread")
        throw Error("Expected thread subscription");
      return client.rpc(
        session.request("subscription.openThread", {
          subscriptionId: info.subscriptionId,
          streamId: id,
          threadId: info.installed.scope.threadId,
          knownWindow: [],
          recheckTodos: [],
          after: after ?? info.installed,
        }),
      );
    },
    releaseCredit(id: number, bytes: number) {
      creditHeld = undefined;
      client.acknowledge(id, bytes);
      client.peer.pump();
    },
    close() {
      socket.terminate();
      client.close();
    },
  };
}
export function begin(subscriptionId: string, base: SyncCursor, head: SyncCursor) {
  const m = v.parse(ControlMessageSchema, {
    kind: "subscription.begin",
    subscriptionId,
    passId: `${subscriptionId}-pass-${head.through}`,
    base,
    through: head,
    mode: "merge",
  });
  if (m.kind !== "subscription.begin") throw Error("Expected begin");
  return m;
}
