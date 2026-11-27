import { mkdir } from "node:fs/promises";
import {
  FlowPeer,
  BUSINESS_WEBSOCKET_PATH,
  type FrameSink,
  type ConnectionId,
  type SessionAuthorized,
  type WireMessage,
  TRANSPORT_LIMITS,
} from "@kraka/protocol";

export interface SocketApplication {
  epoch: ConnectionId;
  beforeSend?(): void;
  write?(data: WireMessage, send: (data: WireMessage) => number): number;
  attach(peer: FlowPeer, wake: () => void): FrameSink & { close(): void };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
export const utf8 = {
  encode: (s: string) => encoder.encode(s),
  decode: (b: Uint8Array) => decoder.decode(b),
};

export function attachFlow(
  app: SocketApplication,
  ws: Pick<Bun.ServerWebSocket<unknown>, "send" | "close">,
) {
  let sink: ReturnType<SocketApplication["attach"]>;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = (data: WireMessage) => ws.send(data, false);
  let authorization: SessionAuthorized | null = null,
    configured = false;
  const peer = new FlowPeer(
    app.epoch,
    {
      utf8,
      now: () => performance.now(),
      ...(app.beforeSend ? { beforeSend: app.beforeSend } : {}),
      write: (data) => (app.write ? app.write(data, send) : send(data)),
      sentControl(m) {
        if (m.kind === "session.authorized") {
          authorization = m;
          configured = false;
        }
        if (m.kind === "session.configuration")
          configured =
            authorization?.connectionId === app.epoch &&
            m.connectionId === app.epoch &&
            authorization.environmentId === m.environment.id &&
            authorization.environmentSessionId === m.environmentSessionId;
      },
    },
    {
      control: (m) => {
        if (
          m.kind === "signedRequest" &&
          (!configured ||
            !authorization ||
            m.connectionId !== app.epoch ||
            m.environmentId !== authorization.environmentId ||
            m.signer.kind !== authorization.signer.kind ||
            m.signer.keyId !== authorization.signer.keyId)
        )
          throw new Error("Unavailable session");
        sink.control(m);
      },
      data: (f, n) => {
        if (!configured) throw new Error("Unavailable session");
        sink.data(f, n);
      },
      discarded: (id) => sink.discarded(id),
    },
  );
  const wake = () => {
    if (scheduled) return;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      try {
        clearTimeout(timer);
        if (peer.pump()) wake();
        else if (Number.isFinite(peer.send.nextDeadline))
          timer = setTimeout(
            wake,
            Math.max(1, Math.ceil(peer.send.nextDeadline - performance.now())),
          );
      } catch {
        ws.close(1011);
      }
    });
  };
  const session = {
    peer,
    wake,
    dispose: () => {
      clearTimeout(timer);
      if (scheduled) clearImmediate(scheduled);
      peer.close();
      sink?.close();
    },
  };
  try {
    sink = app.attach(peer, wake);
    wake();
  } catch {
    ws.close(1011);
  }
  return session;
}
export async function listenFlow(options: {
  stateDir: string;
  host: string;
  port: number;
  application?: (request: Request) => SocketApplication | null;
}) {
  if (
    !options.stateDir ||
    options.host !== "127.0.0.1" ||
    !Number.isInteger(options.port) ||
    options.port < 0 ||
    options.port > 65535
  )
    throw new Error("Expected loopback host, state directory and a port from 0 to 65535");
  await mkdir(options.stateDir, { recursive: true });
  type Session = { peer: FlowPeer; wake: () => void; dispose: () => void };
  type Socket = Bun.ServerWebSocket<{ app: SocketApplication; session: Session | null }>;
  const sockets = new Set<Socket>();
  const server = Bun.serve({
    hostname: options.host,
    port: options.port,
    fetch(request, srv) {
      if (new URL(request.url).pathname !== BUSINESS_WEBSOCKET_PATH)
        return new Response(null, { status: 404 });
      const app = options.application?.(request);
      if (!app) return new Response(null, { status: 403 });
      if (!srv.upgrade(request, { data: { app, session: null } }))
        return new Response(null, { status: 400 });
    },
    websocket: {
      data: {} as Socket["data"],
      perMessageDeflate: false,
      maxPayloadLength: TRANSPORT_LIMITS.maxDataChunkBytes,
      idleTimeout: 0,
      open(ws) {
        sockets.add(ws);
        const app = ws.data.app;
        ws.data.session = attachFlow(app, ws);
      },
      message(ws, data) {
        const session = ws.data.session;
        if (!session) return;
        try {
          session.peer.input(data);
          session.wake();
        } catch {
          ws.close(1002);
        }
      },
      drain(ws) {
        const session = ws.data.session;
        try {
          session?.peer.drain();
          session?.wake();
        } catch {
          ws.close(1011);
        }
      },
      close(ws) {
        ws.data.session?.dispose();
        ws.data.session = null;
        sockets.delete(ws);
      },
    },
  });
  const ready = {
    kind: "ready",
    host: server.hostname,
    port: server.port,
    origin: server.url.origin,
  };
  return {
    ready,
    async shutdown() {
      for (const ws of sockets) ws.terminate();
      await server.stop(true);
    },
  };
}
