import { attachFlow, type SocketApplication } from "./flow-socket";
import { createServer as createTLS } from "node:https";
import { browserPage, type preflight } from "./browser-listener";
import { createServer, type IncomingMessage, type RequestListener } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import * as v from "valibot";
import { exchangeVerified, type AccessStore } from "@kraka/environment";
import {
  BUSINESS_CLOSE_CODES,
  ControlStream,
  type WireMessage,
  checkBusinessUpgrade,
  canonicalHttpOrigin,
  ClientAuthenticationSchema,
  SignedRequestSchema,
  ControlMessageSchema,
  PairingRequestSchema,
  PairingExchangeSchema,
  ConnectionIdSchema,
  ConnectionChallengeIdSchema,
  EnvironmentSessionIdSchema,
  PairingClaimIdSchema,
  canonicalJson,
  base64url,
  TRANSPORT_LIMITS,
  PAIRING_LIMITS,
  type RegisteredDevice,
  type ServerHello,
  type EnvironmentIdentity,
  type SignedRequest,
  type SessionConfiguration,
  type CommandReceipt,
  type SessionRejected,
  type SessionAuthorized,
  type ClientAuthentication,
  type PairingPending,
  type PairingChallenge,
  type SubscriptionId,
  type ThreadId,
  type ControlMessage,
  type DeviceId,
  type CommandId,
  type DevicePairingResult,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";

type IdentityDevice = Pick<
  RegisteredDevice,
  "identity" | "deviceId" | "keyId" | "deviceKey" | "principal" | "publicKey"
>;
export interface IdentityPort {
  identity: EnvironmentIdentity;
  sign(message: string): Promise<string>;
  registration(signer: ClientAuthentication["signer"]): IdentityDevice | null;
  configuration: Pick<
    SessionConfiguration,
    "version" | "environment" | "executors" | "description"
  >;
  request(device: IdentityDevice, request: SignedRequest): CommandReceipt | Promise<CommandReceipt>;
  login?(
    device: IdentityDevice,
    request: import("./instance-login").LoginRequest,
    session: import("./instance-login").LoginSession,
  ): Promise<CommandReceipt>;
  access?: AccessStore;
  claimListener?: () => () => void;
  observed?: (event: {
    kind:
      | "hello"
      | "proof"
      | "applied"
      | "selected"
      | "exchanged"
      | "accepted"
      | "revoked"
      | "receivedProof"
      | "receivedBusiness";
    deviceId?: DeviceId;
    commandId?: CommandId;
    connectionId?: ServerHello["connectionId"];
    address?: string;
    sequence?: number;
  }) => void;
  pairingPending?: (pending: PairingPending) => void;
  confirmInstance?: (nonce: string) => string | null;
  openThread?: (nonce: string) => Promise<SocketApplication | null>;
  beforeConfiguration?: (session: SessionAuthorized) => Promise<void>;
  beforePairingReply?: (result: DevicePairingResult) => Promise<void>;
}
type Peer = {
  flow?: ControlStream;
  socket: WebSocket;
  hello: Omit<ServerHello, "identityProof">;
  issued: number;
  session: SessionAuthorized | null;
  sequence: number;
  closed: boolean;
  lifetime: AbortController;
  pendingBytes: number;
  work: Promise<void>;
  application: PairingPending | null;
  challenge: { frame: PairingChallenge; issuedAt: number } | null;
  subscriptions: Map<SubscriptionId, ThreadId>;
};
const randomChallenge = () => base64url(crypto.getRandomValues(new Uint8Array(32)));
function readFrame(text: string): Record<string, unknown> {
  const raw: unknown = JSON.parse(text);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Error("Expected control object");
  const keys: Set<string>[] = [];
  for (const token of text.matchAll(/"(?:[^"\\]|\\.)*"\s*:?|[{}]/g)) {
    if (token[0] === "{") keys.push(new Set());
    else if (token[0] === "}") keys.pop();
    else if (token[0].endsWith(":")) {
      const key: string = JSON.parse(token[0].slice(0, -1));
      const object = keys.at(-1);
      if (!object || object.has(key)) throw Error("Duplicate JSON property");
      object.add(key);
    }
  }
  return raw as Record<string, unknown>;
}
export function listenIdentity(
  host: IdentityPort,
  port = 0,
  allowedOrigins: readonly string[] = [],
  publishedOrigin?: string,
  browser?: { binding: Awaited<ReturnType<typeof preflight>>; asset: string; fixturePage?: string },
) {
  if (host.configuration.environment.id !== host.identity.id)
    throw Error("Configuration belongs to a different environment");
  const now = host.access?.now ?? Date.now;
  const peers = new Set<Peer>();
  const origins = new Set(
    [...allowedOrigins, ...(publishedOrigin === undefined ? [] : [publishedOrigin])].map((raw) => {
      const origin = canonicalHttpOrigin(raw, URL);
      if (!origin) throw Error("Invalid configured HTTP origin");
      return origin;
    }),
  );
  const seen = new Map<string, number>();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: TRANSPORT_LIMITS.maxControlFrameBytes,
  });
  function close(p: Peer, code: number) {
    if (p.closed) return;
    p.closed = true;
    p.lifetime.abort();
    p.challenge = null;
    p.subscriptions.clear();
    p.flow?.close();
    p.socket.close(code);
  }
  function send(p: Peer, message: unknown) {
    if (p.closed) return;
    if (!p.flow) {
      p.socket.send(JSON.stringify(message));
      return;
    }
    p.flow.send(v.parse(ControlMessageSchema, message));
  }
  function reject(p: Peer, reason: SessionRejected["reason"]) {
    send(p, { kind: "session.rejected", reason } satisfies SessionRejected);
    close(p, reason === "unsupportedProtocolVersion" ? 1002 : BUSINESS_CLOSE_CODES.revoked);
  }
  function challenge(p: Peer) {
    const app = p.application;
    if (!host.access || !app || p.closed || p.challenge) return;
    const s = host.access.invitation(app.inviteId);
    if (!s || (s.kind !== "selected" && s.kind !== "consumed")) return;
    const frame: PairingChallenge = {
      kind: "pairing.challenge",
      requestId: app.requestId,
      claimId:
        s.selection.requestId === app.requestId
          ? s.selection.claimId
          : v.parse(PairingClaimIdSchema, crypto.randomUUID()),
      challengeId: v.parse(ConnectionChallengeIdSchema, crypto.randomUUID()),
      challenge: randomChallenge(),
    };
    p.challenge = { frame, issuedAt: now() };
    send(p, frame);
  }
  if (host.access)
    host.access.live = {
      sessions: () => [...peers].flatMap((p) => (p.session ? [p.session] : [])),
      notify(event) {
        if (event.kind === "selected") host.observed?.({ kind: "selected" });
        for (const p of peers) {
          const session = p.session;
          if (event.kind === "selected" && p.application?.inviteId === event.inviteId) challenge(p);
          if (
            event.kind === "revoked" &&
            ((session?.signer.kind === "device" &&
              session.signer.deviceId === event.deviceId &&
              session.signer.keyId === event.keyId) ||
              p.application?.deviceId === event.deviceId)
          )
            close(p, BUSINESS_CLOSE_CODES.revoked);
          if (event.kind === "grantsChanged" && session)
            for (const [id, threadId] of p.subscriptions)
              if (
                !host.access?.ceiling(
                  session.principal.id,
                  { kind: "thread", threadId },
                  "thread.view",
                )
              ) {
                p.subscriptions.delete(id);
                send(p, {
                  kind: "subscription.ended",
                  subscriptionId: id,
                  reason: "authorizationRevoked",
                });
              }
        }
        if (event.kind === "revoked")
          host.observed?.({ kind: "revoked", deviceId: event.deviceId });
      },
    };
  function refuseProof(p: Peer, why: SessionRejected["reason"], commandId?: CommandId) {
    if (!commandId) return reject(p, why);
    if (why !== "revokedKey")
      send(p, {
        kind: "rejected",
        commandId,
        failure: { kind: why === "keyExpired" ? "expired" : "invalidProof" },
      } satisfies CommandReceipt);
    close(p, BUSINESS_CLOSE_CODES.revoked);
  }
  function current(p: Peer, signer: ClientAuthentication["signer"], commandId?: CommandId) {
    const device = host.registration(signer);
    if (
      !device ||
      signer.kind !== "device" ||
      signer.deviceId !== device.deviceId ||
      signer.keyId !== device.keyId ||
      canonicalJson(device.identity) !== canonicalJson(p.hello.identity)
    ) {
      refuseProof(p, "unknownKey", commandId);
      return null;
    }
    if (device.deviceKey.state.kind === "revoked") {
      refuseProof(p, "revokedKey", commandId);
      return null;
    }
    if (now() >= device.deviceKey.state.expiresAt) {
      refuseProof(p, "keyExpired", commandId);
      return null;
    }
    return device;
  }
  async function handle(p: Peer, text: string) {
    if (p.closed) return;
    let raw: Record<string, unknown>;
    try {
      raw = readFrame(text);
    } catch {
      return close(p, 1007);
    }
    const hello = p.hello,
      store = host.access;
    if (!p.session && store && raw.kind === "pairing.request") {
      const parsed = v.safeParse(PairingRequestSchema, raw);
      if (!parsed.success || (p.application && p.application.requestId !== parsed.output.requestId))
        return close(p, 1007);
      const result = store.application(parsed.output);
      if (typeof result === "string") {
        send(p, { kind: "pairing.rejected", requestId: parsed.output.requestId, reason: result });
        return;
      }
      p.application = result;
      host.observed?.({ kind: "applied", deviceId: result.deviceId });
      send(p, result);
      host.pairingPending?.(result);
      challenge(p);
      return;
    }
    if (!p.session && store && raw.kind === "pairing.exchange") {
      const parsed = v.safeParse(PairingExchangeSchema, raw);
      if (!parsed.success) return close(p, 1007);
      const x = parsed.output,
        c = p.challenge,
        app = p.application;
      p.challenge = null;
      let result: DevicePairingResult = {
        kind: "pairing.rejected",
        requestId: x.requestId,
        reason: "invalidProof",
      };
      if (
        c &&
        app &&
        x.deviceId === app.deviceId &&
        x.publicKey === app.publicKey &&
        x.requestId === app.requestId &&
        x.inviteId === app.inviteId &&
        x.protocolVersion.major === hello.protocolVersion.major &&
        x.protocolVersion.minor <= hello.protocolVersion.minor
      ) {
        result = await exchangeVerified({
          exchange: x,
          challenge: c.frame,
          issuedAt: c.issuedAt,
          now,
          store,
          active: () => !p.closed,
        });
      }
      if (result.kind === "pairing.completed")
        host.observed?.({ kind: "exchanged", deviceId: x.deviceId });
      await host.beforePairingReply?.(result);
      send(p, result);
      return;
    }
    if (p.session && raw.kind === "transport.probe") {
      const parsed = v.safeParse(ControlMessageSchema, raw);
      if (!parsed.success || parsed.output.kind !== "transport.probe") return close(p, 1007);
      if (current(p, p.session.signer))
        send(p, { kind: "transport.echo", serial: parsed.output.serial });
      return;
    }
    if (p.application) return close(p, 1007);
    const parsed = p.session
      ? v.safeParse(SignedRequestSchema, raw)
      : v.safeParse(ClientAuthenticationSchema, raw);
    if (!parsed.success) return close(p, 1007);
    const m = parsed.output;
    host.observed?.({
      kind: m.kind === "client.authenticate" ? "receivedProof" : "receivedBusiness",
      connectionId: hello.connectionId,
      sequence: m.sequence,
      ...(m.signer.kind === "device" ? { deviceId: m.signer.deviceId } : {}),
      ...(m.kind === "signedRequest" ? { commandId: m.commandId } : {}),
    });
    const commandId = m.kind === "signedRequest" ? m.commandId : undefined;
    const registered = p.session ? current(p, p.session.signer, commandId) : null;
    if (p.session && !registered) return;
    if (
      m.protocolVersion.major !== hello.protocolVersion.major ||
      m.protocolVersion.minor > hello.protocolVersion.minor ||
      (p.session && m.protocolVersion.minor !== p.session.protocolVersion.minor)
    )
      return reject(p, "unsupportedProtocolVersion");
    if (
      m.environmentId !== hello.identity.id ||
      m.connectionId !== hello.connectionId ||
      m.challengeId !== hello.challengeId ||
      m.challenge !== hello.challenge ||
      (m.kind === "client.authenticate" &&
        (m.clientNonce !== hello.clientNonce || now() - p.issued >= PAIRING_LIMITS.challengeMs))
    )
      return refuseProof(p, "challengeExpired", commandId);
    const device = registered ?? current(p, m.signer);
    if (!device) return;
    const { signature: _sig, ...fields } = raw;
    if (
      (p.session && canonicalJson(m.signer) !== canonicalJson(p.session.signer)) ||
      !(await verifyP256(device.publicKey, canonicalJson(fields), m.signature))
    )
      return refuseProof(p, "invalidSignature", commandId);
    if (p.closed || !current(p, m.signer, commandId)) return;
    if (m.sequence !== p.sequence + 1) {
      if (!commandId) return reject(p, "invalidSignature");
      send(p, {
        kind: "rejected",
        commandId,
        failure: { kind: "staleSequence" },
      } satisfies CommandReceipt);
      return close(p, BUSINESS_CLOSE_CODES.revoked);
    }
    p.sequence = m.sequence;
    host.observed?.({
      kind: "proof",
      deviceId: device.deviceId,
      connectionId: hello.connectionId,
      sequence: m.sequence,
    });
    if (m.kind === "client.authenticate") {
      if (now() - p.issued >= PAIRING_LIMITS.challengeMs) return reject(p, "challengeExpired");
      if (
        m.features.some((f) => !hello.features.includes(f)) ||
        new Set(m.features).size !== m.features.length
      )
        return reject(p, "unsupportedProtocolVersion");
      const session: SessionAuthorized = {
        kind: "session.authorized",
        environmentId: hello.identity.id,
        connectionId: hello.connectionId,
        environmentSessionId: v.parse(EnvironmentSessionIdSchema, crypto.randomUUID()),
        principal: device.principal,
        signer: m.signer,
        authorizedAt: now(),
        protocolVersion: m.protocolVersion,
        features: m.features,
      };
      p.session = session;
      send(p, session);
      if (host.beforeConfiguration) await host.beforeConfiguration(session);
      if (p.closed) return;
      send(p, {
        ...host.configuration,
        kind: "session.configuration",
        connectionId: hello.connectionId,
        environmentSessionId: session.environmentSessionId,
        transportLimits: TRANSPORT_LIMITS,
      } satisfies SessionConfiguration);
    } else {
      const login =
        m.method === "executor.startLogin" ||
        m.method === "executor.readLogin" ||
        m.method === "executor.cancelLogin"
          ? m
          : null;
      const pending =
        login && p.session && host.login
          ? host.login(device, login, {
              id: p.session.environmentSessionId,
              owner: device.principal.ownerId,
              signal: p.lifetime.signal,
              active: () => !p.closed && !!current(p, m.signer),
            })
          : host.request(device, m);
      const receipt = pending instanceof Promise ? await pending : pending;
      if (p.closed || !current(p, m.signer) || receipt.commandId !== m.commandId) return;
      if (
        login &&
        receipt.kind === "accepted" &&
        !host.access?.ceiling(
          device.principal.id,
          { kind: "environment", environmentId: host.identity.id },
          "settings.change",
        )
      ) {
        send(p, { kind: "rejected", commandId: m.commandId, failure: { kind: "notFound" } });
        return;
      }
      if (receipt.kind === "accepted") {
        host.observed?.({
          kind: "accepted",
          deviceId: device.deviceId,
          commandId: m.commandId,
          connectionId: hello.connectionId,
          sequence: m.sequence,
        });
        if (
          m.method === "subscription.openThread" &&
          receipt.result.kind === "subscriptionOpened" &&
          store?.ceiling(
            device.principal.id,
            { kind: "thread", threadId: m.payload.threadId },
            "thread.view",
          )
        )
          p.subscriptions.set(m.payload.subscriptionId, m.payload.threadId);
      }
      send(p, receipt);
    }
  }
  function admission(req: IncomingMessage) {
    const incoming: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2)
      if (req.rawHeaders[i]?.toLowerCase() === "origin") incoming.push(req.rawHeaders[i + 1] ?? "");
    return checkBusinessUpgrade(req.url ?? "", incoming, [...origins], URL);
  }
  const serve: RequestListener = (req, res) => {
    const proof = /^\/instance\/([a-f0-9]{48}(?:\?idle)?)$/.exec(req.url ?? "");
    if (host.confirmInstance && proof?.[1] && req.method === "GET") {
      const answer = host.confirmInstance(proof[1]);
      res.writeHead(answer ? 200 : 409);
      res.end(answer);
      return;
    }
    if (browser && (req.method === "GET" || req.method === "HEAD")) {
      const js = req.url === "/assets/browser-host.js";
      const content = js
        ? browser.asset
        : req.url === "/"
          ? browserPage()
          : req.url === "/__fixture__/browser.html"
            ? browser.fixturePage
            : undefined;
      if (content !== undefined) {
        res.writeHead(200, {
          "Content-Type": js ? "text/javascript; charset=utf-8" : "text/html; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
        });
        res.end(req.method === "HEAD" ? undefined : content);
        return;
      }
      if (req.url === "/ws" && !req.headers.upgrade) {
        res.writeHead(403);
        res.end();
        return;
      }
    }
    const d = admission(req);
    res.writeHead(d.kind === "reject" ? d.status : 400);
    res.end();
  };
  const server = browser?.binding.tls ? createTLS(browser.binding.tls, serve) : createServer(serve);
  server.on("upgrade", (req, socket, head) => {
    const d = admission(req);
    for (const [n, end] of seen) {
      if (end > now()) break;
      seen.delete(n);
    }
    if (d.kind === "reject" || seen.has(d.nonce)) {
      const status = d.kind === "reject" ? d.status : 400;
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    seen.set(d.nonce, now() + PAIRING_LIMITS.challengeMs);
    if (browser && req.headers["sec-websocket-protocol"] === "kraka.thread.v1") {
      void host
        .openThread?.(d.nonce)
        .then((app) => {
          if (!app || socket.destroyed) return socket.destroy();
          sockets.handleUpgrade(req, socket, head, (ws) => {
            const session = attachFlow(app, {
              send(data) {
                ws.send(data);
                return 1;
              },
              close(code) {
                ws.close(code);
              },
            });
            ws.on("message", (data, binary) => {
              try {
                if (!Buffer.isBuffer(data)) throw Error("Invalid frame");
                session.peer.input(binary ? data : data.toString());
                session.wake();
              } catch {
                ws.close(1002);
              }
            });
            ws.on("close", () => session.dispose());
            ws.on("error", () => ws.terminate());
          });
        })
        .catch(() => socket.destroy());
      if (!host.openThread) socket.destroy();
      return;
    }
    sockets.handleUpgrade(req, socket, head, (ws) => {
      const hello: Peer["hello"] = {
        kind: "server.hello",
        identity: host.identity,
        connectionId: v.parse(ConnectionIdSchema, crypto.randomUUID()),
        challengeId: v.parse(ConnectionChallengeIdSchema, crypto.randomUUID()),
        challenge: randomChallenge(),
        clientNonce: d.nonce,
        protocolVersion: { major: 1, minor: 0 },
        features: ["strictSchemas", "signedRequests"],
      };
      const peer: Peer = {
        socket: ws,
        issued: now(),
        hello,
        session: null,
        sequence: 0,
        closed: false,
        lifetime: new AbortController(),
        pendingBytes: 0,
        work: Promise.resolve(),
        application: null,
        challenge: null,
        subscriptions: new Map(),
      };
      if (browser && req.headers["sec-websocket-protocol"] === "kraka.flow.v1") {
        const utf8 = {
          encode: (s: string) => new TextEncoder().encode(s),
          decode: (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b),
        };
        peer.flow = new ControlStream(
          hello.connectionId,
          {
            utf8,
            now: () => performance.now(),
            write(data: WireMessage) {
              ws.send(data);
              return 1;
            },
          },
          () => !!peer.session,
          (message) => enqueue(JSON.stringify(message)),
        );
      }
      peers.add(peer);
      peer.work = host
        .sign(canonicalJson(hello))
        .then((identityProof) => {
          send(peer, { ...hello, identityProof });
          host.observed?.({
            kind: "hello",
            connectionId: hello.connectionId,
            ...(req.socket.remoteAddress ? { address: req.socket.remoteAddress } : {}),
          });
        })
        .catch(() => close(peer, 1011));
      function enqueue(text: string) {
        const size = Buffer.byteLength(text);
        peer.pendingBytes += size;
        if (peer.pendingBytes > TRANSPORT_LIMITS.maxPendingControlBytes) return close(peer, 1009);
        peer.work = peer.work
          .then(() => handle(peer, text))
          .catch(() => close(peer, 1011))
          .finally(() => {
            peer.pendingBytes -= size;
          });
      }
      ws.on("message", (data, binary) => {
        if (binary) {
          if (!peer.flow || !Buffer.isBuffer(data)) return close(peer, 1007);
          try {
            peer.flow.input(data);
          } catch {
            close(peer, 1007);
          }
          return;
        }
        const text = data.toString();
        if (!peer.flow) {
          enqueue(text);
          return;
        }
        try {
          readFrame(text);
          peer.flow.input(text);
        } catch {
          close(peer, 1007);
        }
      });
      ws.on("close", () => {
        peer.closed = true;
        peer.lifetime.abort();
        peer.subscriptions.clear();
        peer.flow?.close();
        void peer.work.finally(() => peers.delete(peer));
      });
      ws.on("error", () => close(peer, 1011));
    });
  });
  const release = host.claimListener?.();
  const address = (() => {
    try {
      server.listen(port, browser?.binding.host ?? "127.0.0.1");
      const bound = server.address();
      if (!bound || typeof bound === "string") throw Error("Loopback bind failed");
      return bound;
    } catch (e) {
      release?.();
      throw e;
    }
  })();
  const name = browser?.binding.publishedHost ?? "127.0.0.1";
  const origin = new URL(
    (browser?.binding.protocol ?? "http") +
      "://" +
      (name.includes(":") && !name.startsWith("[") ? `[${name}]` : name) +
      ":" +
      address.port,
  ).origin;
  if (publishedOrigin === undefined) origins.add(origin);
  function publish(
    threadId: ThreadId,
    frame: Extract<ControlMessage, { kind: "subscription.reset" }>,
  ) {
    for (const p of peers) {
      if (p.subscriptions.get(frame.subscriptionId) !== threadId || !p.session) continue;
      const device = current(p, p.session.signer);
      if (
        device &&
        host.access?.ceiling(device.principal.id, { kind: "thread", threadId }, "thread.view")
      )
        send(p, frame);
    }
  }
  return {
    origin,
    ready: { kind: "ready", host: address.address, port: address.port, origin },
    publish,
    async close() {
      const work = [...peers].map((p) => {
        p.closed = true;
        p.lifetime.abort();
        p.socket.terminate();
        return p.work;
      });
      peers.clear();
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
      await Promise.allSettled(work);
      release?.();
    },
  };
}
