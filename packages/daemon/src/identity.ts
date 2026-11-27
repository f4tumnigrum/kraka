import * as v from "valibot";
import {
  BUSINESS_CLOSE_CODES,
  checkBusinessUpgrade,
  ClientAuthenticationSchema,
  SignedRequestSchema,
  ControlMessageSchema,
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
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  ConnectionIdSchema,
  ConnectionChallengeIdSchema,
  EnvironmentSessionIdSchema,
} from "@kraka/protocol";

/** The host supplies its own identity key and resolves registrations locally. */
export interface IdentityPort {
  identity: EnvironmentIdentity;
  sign(message: string): Promise<string>;
  registration(signer: ClientAuthentication["signer"]): RegisteredDevice | null;
  configuration: Pick<
    SessionConfiguration,
    "version" | "environment" | "executors" | "description"
  >;
  request(device: RegisteredDevice, request: SignedRequest): Promise<CommandReceipt>;
}
type Peer = {
  hello: Omit<ServerHello, "identityProof">;
  issued: number;
  session: SessionAuthorized | null;
  sequence: number;
  closed: boolean;
  pendingBytes: number;
  work: Promise<void>;
};

export function listenIdentity(
  host: IdentityPort,
  port = 0,
  allowedOrigins: readonly string[] = [],
) {
  if (host.configuration.environment.id !== host.identity.id)
    throw Error("Configuration belongs to a different environment");
  const close = (ws: Bun.ServerWebSocket<Peer>, code: number) => {
    ws.data.closed = true;
    ws.close(code);
  };
  function reject(ws: Bun.ServerWebSocket<Peer>, reason: SessionRejected["reason"]) {
    ws.send(JSON.stringify({ kind: "session.rejected", reason } satisfies SessionRejected));
    close(ws, BUSINESS_CLOSE_CODES.revoked);
  }
  async function handle(ws: Bun.ServerWebSocket<Peer>, text: string) {
    const p = ws.data;
    if (p.closed) return;
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      return close(ws, 1007);
    }
    const hello = p.hello;
    if (p.session) {
      const parsed = v.safeParse(ControlMessageSchema, raw);
      if (parsed.success && parsed.output.kind === "transport.probe") {
        ws.send(JSON.stringify({ kind: "transport.echo", serial: parsed.output.serial }));
        return;
      }
    }
    const msg = p.session
      ? v.safeParse(SignedRequestSchema, raw)
      : v.safeParse(ClientAuthenticationSchema, raw);
    if (!msg.success) return close(ws, 1007);
    const { signature, ...fields } = msg.output;
    if (
      fields.protocolVersion.major !== hello.protocolVersion.major ||
      fields.protocolVersion.minor > hello.protocolVersion.minor
    )
      return reject(ws, "unsupportedProtocolVersion");
    if (
      fields.environmentId !== hello.identity.id ||
      fields.connectionId !== hello.connectionId ||
      fields.challenge !== hello.challenge ||
      fields.challengeId !== hello.challengeId ||
      (fields.kind === "client.authenticate" &&
        (fields.clientNonce !== hello.clientNonce ||
          performance.now() - p.issued >= PAIRING_LIMITS.challengeMs))
    )
      return reject(ws, "challengeExpired");
    const device = host.registration(fields.signer);
    if (
      !device ||
      fields.signer.kind !== "device" ||
      fields.signer.deviceId !== device.deviceId ||
      fields.signer.keyId !== device.keyId ||
      device.identity.id !== hello.identity.id ||
      device.identity.publicKey !== hello.identity.publicKey ||
      device.identity.keyVersion !== hello.identity.keyVersion
    )
      return reject(ws, "unknownKey");
    if (device.deviceKey.state.kind === "revoked") return reject(ws, "revokedKey");
    if (device.deviceKey.state.expiresAt <= Date.now()) return reject(ws, "keyExpired");
    if (
      fields.sequence !== p.sequence + 1 ||
      !(await verifyP256(device.publicKey, canonicalJson(fields), signature))
    )
      return reject(ws, "invalidSignature");
    if (p.closed) return;
    p.sequence = fields.sequence;
    if (fields.kind === "client.authenticate") {
      if (
        fields.features.some((f) => !hello.features.includes(f)) ||
        new Set(fields.features).size !== fields.features.length
      )
        return reject(ws, "unsupportedProtocolVersion");
      const session: SessionAuthorized = {
        kind: "session.authorized",
        environmentId: hello.identity.id,
        connectionId: hello.connectionId,
        environmentSessionId: v.parse(EnvironmentSessionIdSchema, crypto.randomUUID()),
        principal: device.principal,
        signer: fields.signer,
        authorizedAt: Date.now(),
        protocolVersion: fields.protocolVersion,
        features: fields.features,
      };
      p.session = session;
      ws.send(JSON.stringify(session));
      ws.send(
        JSON.stringify({
          ...host.configuration,
          kind: "session.configuration",
          connectionId: hello.connectionId,
          environmentSessionId: session.environmentSessionId,
          transportLimits: TRANSPORT_LIMITS,
        } satisfies SessionConfiguration),
      );
    } else if (msg.output.kind === "signedRequest" && p.session) {
      if (
        p.session.signer.kind !== "device" ||
        p.session.signer.deviceId !== device.deviceId ||
        p.session.signer.keyId !== device.keyId
      )
        return reject(ws, "unknownKey");
      const receipt = await host.request(device, msg.output);
      if (!p.closed && receipt.commandId === fields.commandId) ws.send(JSON.stringify(receipt));
    }
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    fetch(req, srv) {
      const target = req.url.slice(req.url.indexOf("/", req.url.indexOf("://") + 3));
      const origin = req.headers.get("origin");
      const decision = checkBusinessUpgrade(
        target,
        origin === null ? [] : [origin],
        allowedOrigins,
        URL,
      );
      if (decision.kind === "reject") return new Response(null, { status: decision.status });
      const hello: Peer["hello"] = {
        kind: "server.hello",
        identity: host.identity,
        connectionId: v.parse(ConnectionIdSchema, crypto.randomUUID()),
        challengeId: v.parse(ConnectionChallengeIdSchema, crypto.randomUUID()),
        challenge: base64url(crypto.getRandomValues(new Uint8Array(32))),
        clientNonce: decision.nonce,
        protocolVersion: { major: 1, minor: 0 },
        features: ["strictSchemas", "signedRequests"],
      };
      if (
        srv.upgrade(req, {
          data: {
            hello,
            issued: performance.now(),
            sequence: 0,
            session: null,
            closed: false,
            pendingBytes: 0,
            work: Promise.resolve(),
          },
        })
      )
        return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      data: {} as Peer,
      maxPayloadLength: TRANSPORT_LIMITS.maxControlFrameBytes,
      open(ws) {
        const p = ws.data;
        p.work = host
          .sign(canonicalJson(p.hello))
          .then((identityProof) => {
            if (!p.closed) ws.send(JSON.stringify({ ...p.hello, identityProof }));
          })
          .catch(() => close(ws, 1011));
      },
      message(ws, frame) {
        if (typeof frame !== "string") return close(ws, 1007);
        const size = Buffer.byteLength(frame);
        const p = ws.data;
        p.pendingBytes += size;
        if (p.pendingBytes > TRANSPORT_LIMITS.maxPendingControlBytes) return close(ws, 1009);
        p.work = p.work
          .then(() => handle(ws, frame))
          .catch(() => close(ws, 1011))
          .finally(() => {
            p.pendingBytes -= size;
          });
      },
      close(ws) {
        ws.data.closed = true;
      },
    },
  });
  return { origin: `http://127.0.0.1:${server.port}`, close: () => server.stop(true) };
}
