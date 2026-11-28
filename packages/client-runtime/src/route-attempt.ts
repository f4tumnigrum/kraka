import * as v from "valibot";
import {
  BUSINESS_CLOSE_CODES,
  BUSINESS_WEBSOCKET_PATH,
  ROUTE_LIMITS as limits,
  ServerHelloSchema,
  SessionRejectedSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  matchesAuthorizedConfiguration,
  matchesAuthorization,
  canonicalJson,
  base64url,
  type AuthorizationExpectation,
  type ClientAuthentication,
  type EnvironmentIdentity,
  type Route,
  type RouteDiagnostic,
  type RouteFailureReason,
  type ServerHello,
  type SessionAuthorized,
  type SessionConfiguration,
} from "@kraka/protocol";
import { Deadline, type RouteClock } from "./route-timers";
import type { RandomSource } from "./index";

export type TrustDetail = RouteDiagnostic["detail"];
type TransportTrust = Extract<TrustDetail, { stage: "tlsCertificate" | "sshHostKey" }>;
export type SocketEvent =
  | { kind: "frame"; value: unknown }
  | { kind: "closed"; code?: number; evidence?: "connectionRefused" | TransportTrust };
export type RouteSocket = { send(frame: object): void; close(code: number): void };
export type RouteDial = (url: string, receive: (event: SocketEvent) => void) => RouteSocket;
export type RouteCredentials = {
  identity: EnvironmentIdentity;
  principal: Extract<AuthorizationExpectation["principal"], { kind: "device" }>;
  signer: Extract<AuthorizationExpectation["signer"], { kind: "device" }>;
  sign(canonical: string): Promise<string>;
};
export type RoutePlatform = {
  clock: RouteClock;
  random: RandomSource;
  dial: RouteDial;
  verify(publicKey: string, canonical: string, signature: string): Promise<boolean>;
  credentials: RouteCredentials;
};
export const clientVersion = { major: 1, minor: 0 };
type Callbacks = {
  verified(hello: ServerHello): void;
  authorized(authorized: SessionAuthorized): void;
  configured(
    hello: ServerHello,
    configuration: SessionConfiguration,
    expected: AuthorizationExpectation,
  ): void;
  frame(value: unknown): void;
  failed(reason: RouteFailureReason, detail?: TrustDetail): void;
};
type Phase =
  | "hello"
  | "verifying"
  | "verified"
  | "signing"
  | "authenticating"
  | "configured"
  | "closed";
export class RouteAttempt {
  private phase: Phase = "hello";
  private socket?: RouteSocket;
  private hello?: ServerHello;
  private expected?: AuthorizationExpectation;
  private publicReceiver?: (value: unknown) => void;
  private authorization?: SessionAuthorized;
  private configuration?: SessionConfiguration;
  private readonly timer: Deadline;
  private readonly nonce: string;
  constructor(
    readonly route: Route,
    private readonly pin: EnvironmentIdentity,
    private readonly host: Omit<RoutePlatform, "credentials"> & {
      credentials: RouteCredentials | null;
    },
    private readonly events: Callbacks,
  ) {
    this.timer = new Deadline(host.clock);
    const bytes = host.random.bytes(32);
    if (bytes.length !== 32) throw new Error("Expected 32 nonce bytes");
    this.nonce = base64url(bytes);
  }
  open() {
    this.expireIn(limits.identityTimeoutMs);
    const url =
      this.route.endpoint.replace(/^http/i, "ws").replace(/\/$/, "") +
      BUSINESS_WEBSOCKET_PATH +
      "?nonce=" +
      this.nonce;
    try {
      const socket = this.host.dial(url, (event) => this.receive(event));
      this.socket = socket;
      if (this.phase === "closed") socket.close(BUSINESS_CLOSE_CODES.cancelledAttempt);
    } catch {
      this.fail();
    }
  }
  private expireIn(ms: number) {
    this.timer.set(ms, () => this.fail());
  }
  close(code: number = BUSINESS_CLOSE_CODES.cancelledAttempt) {
    if (this.phase === "closed") return;
    this.phase = "closed";
    this.timer.clear();
    this.socket?.close(code);
  }
  private fail(
    reason: RouteFailureReason = "noResponse",
    detail?: TrustDetail,
    code: number = BUSINESS_CLOSE_CODES.cancelledAttempt,
  ) {
    if (this.phase === "closed") return;
    this.close(code);
    this.events.failed(reason, detail);
  }
  private receive(event: SocketEvent) {
    // A queued receipt from a once-configured socket can still resolve its own command.
    if (this.phase === "closed") {
      if (event.kind === "frame" && this.authorization && this.configuration)
        this.events.frame(event.value);
      return;
    }
    if (this.timer.expired()) return this.fail();
    if (event.kind === "closed") {
      if (this.phase === "configured" && event.code === BUSINESS_CLOSE_CODES.revoked)
        return this.fail("revoked");
      const evidence = event.evidence;
      return typeof evidence === "object"
        ? this.fail("noResponse", evidence)
        : this.fail(evidence ?? "noResponse");
    }
    if (this.publicReceiver) return this.publicReceiver(event.value);
    if (this.phase === "hello") {
      const parsed = v.safeParse(ServerHelloSchema, event.value);
      if (!parsed.success) return this.fail("noResponse", undefined, 1007);
      this.phase = "verifying";
      void this.verifyHello(parsed.output).catch(() => this.fail());
    } else if (this.phase === "authenticating" || this.phase === "configured") {
      const rejected = v.safeParse(SessionRejectedSchema, event.value);
      if (rejected.success) {
        const reason = rejected.output.reason;
        return this.fail(
          { kind: "authenticationRejected", reason },
          { stage: "authentication", reason },
          BUSINESS_CLOSE_CODES.revoked,
        );
      }
      if (this.phase === "configured") this.events.frame(event.value);
      else this.handshakeFrame(event.value);
    } else this.fail("noResponse", undefined, 1007);
  }
  private async verifyHello(hello: ServerHello) {
    const { identityProof, ...fields } = hello;
    const identityError = (
      reason: Extract<TrustDetail, { stage: "environmentIdentity" }>["reason"],
    ) => this.fail("noResponse", { stage: "environmentIdentity", reason });
    if (hello.clientNonce !== this.nonce) return identityError("nonceMismatch");
    const valid = await this.host.verify(
      hello.identity.publicKey,
      canonicalJson(fields),
      identityProof,
    );
    if (this.phase !== "verifying") return;
    if (this.timer.expired()) return this.fail();
    if (!valid) return identityError("invalidSignature");
    if (hello.identity.id !== this.pin.id)
      return this.fail({ kind: "wrongEnvironment", actualEnvironmentId: hello.identity.id });
    if (hello.identity.publicKey !== this.pin.publicKey) return identityError("pinnedKeyMismatch");
    if (hello.identity.keyVersion !== this.pin.keyVersion)
      return identityError("keyVersionMismatch");
    if (hello.protocolVersion.major !== clientVersion.major)
      return this.fail(
        "noResponse",
        {
          stage: "protocolVersion",
          reason: "unsupportedProtocolVersion",
          localVersion: clientVersion,
          remoteVersion: hello.protocolVersion,
        },
        1002,
      );
    this.hello = hello;
    this.phase = "verified";
    this.expireIn(limits.authenticationTimeoutMs);
    this.events.verified(hello);
  }
  stayPublic(receive: (frame: unknown) => void) {
    if (this.phase !== "verified") return;
    this.timer.clear();
    this.publicReceiver = receive;
  }
  async authenticate(supported: ServerHello["features"] = ["strictSchemas", "signedRequests"]) {
    const hello = this.hello;
    if (!hello || this.phase !== "verified" || !this.host.credentials) return;
    if (this.timer.expired()) return this.fail();
    this.phase = "signing";
    const { principal, signer } = this.host.credentials;
    const features = supported.filter((f) => hello.features.includes(f));
    this.expected = { principal, signer, protocolVersion: clientVersion, features };
    const auth: Omit<ClientAuthentication, "signature"> = {
      kind: "client.authenticate",
      protocolVersion: clientVersion,
      environmentId: this.pin.id,
      connectionId: hello.connectionId,
      challengeId: hello.challengeId,
      challenge: hello.challenge,
      clientNonce: this.nonce,
      signer,
      sequence: 1,
      features,
      method: "session.authenticate",
    };
    try {
      const signature = await this.host.credentials.sign(canonicalJson(auth));
      if (this.phase !== "signing") return;
      if (this.timer.expired()) return this.fail();
      this.phase = "authenticating";
      this.send({ ...auth, signature });
    } catch {
      this.fail();
    }
  }
  private handshakeFrame(value: unknown) {
    const authorized = v.safeParse(SessionAuthorizedSchema, value);
    if (authorized.success && !this.authorization) {
      if (
        !this.hello ||
        !this.expected ||
        !matchesAuthorization(this.hello, authorized.output, this.expected)
      )
        return this.fail("noResponse", undefined, 1002);
      this.authorization = authorized.output;
      this.expireIn(limits.configurationIdleTimeoutMs);
      this.events.authorized(authorized.output);
    } else {
      const config = v.safeParse(SessionConfigurationSchema, value);
      if (!config.success || this.configuration) return this.fail("noResponse", undefined, 1007);
      this.configuration = config.output;
    }
    if (!this.hello || !this.expected || !this.authorization || !this.configuration) return;
    if (
      !matchesAuthorizedConfiguration(
        this.hello,
        this.authorization,
        this.configuration,
        this.expected,
      )
    )
      return this.fail("noResponse", undefined, 1002);
    this.phase = "configured";
    this.timer.clear();
    this.events.configured(this.hello, this.configuration, this.expected);
  }
  send(frame: object): boolean {
    if (!this.socket || this.phase === "closed") return false;
    try {
      this.socket.send(frame);
      return true;
    } catch {
      this.fail();
      return false;
    }
  }
}
