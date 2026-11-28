import * as v from "valibot";
import {
  BUSINESS_CLOSE_CODES,
  ROUTE_LIMITS as limits,
  ControlMessageSchema,
  CommandReceiptSchema,
  EnvironmentIdentitySchema,
  RouteDiagnosticSchema,
  canonicalJson,
  describeHost,
  migrateRouteCatalog,
  type ControlMessage,
  type CommandId,
  type TextReturnResult,
  type CommandReceipt,
  type SignedRequest,
  type EnvironmentIdentity,
  type Route,
  type RouteCatalog,
  type RouteDiagnostic,
  type RouteId,
  type RouteStatus,
  type ServerHello,
  type SessionConfiguration,
  type SessionAuthorized,
  type AuthorizationExpectation,
} from "@kraka/protocol";
import { RouteAttempt, type RoutePlatform, type TrustDetail } from "./route-attempt";
import { Deadline, monitorRoute, retryDelay } from "./route-timers";
import { sameEnvironmentIdentity } from "./session";

type CommandFields<T> = T extends { method: unknown; payload: unknown; commandId: CommandId }
  ? Pick<T, "method" | "payload" | "commandId">
  : never;
export type RouteCommand = CommandFields<SignedRequest>;

export type RouteEvent =
  | { kind: "route"; routeId: RouteId; status: RouteStatus }
  | { kind: "diagnostic"; diagnostic: RouteDiagnostic }
  | { kind: "authorized"; routeId: RouteId; authorized: SessionAuthorized }
  | {
      kind: "sender";
      routeId: RouteId;
      hello: ServerHello;
      configuration: SessionConfiguration;
      epoch: number;
    }
  | { kind: "disconnected"; routeId: RouteId }
  | { kind: "receipt"; receipt: CommandReceipt }
  | { kind: "textReturned"; commandId: CommandId; result: TextReturnResult }
  | { kind: "control"; epoch: number; frame: ControlMessage };

type Options = RoutePlatform & {
  expectedIdentity: EnvironmentIdentity;
  orderedRoutes: readonly Route[];
  features?: ServerHello["features"];
  activeEpoch: number;
  observe?(event: RouteEvent): void;
};
export function orderedCatalogRoutes(entry: RouteCatalog["environments"][number]) {
  const preferred = entry.routes.find((route) => route.id === entry.preferredRouteId);
  return preferred
    ? [preferred, ...entry.routes.filter((route) => route !== preferred)]
    : entry.routes;
}
type Sender = {
  attempt: RouteAttempt;
  hello: ServerHello;
  expected: AuthorizationExpectation;
  configuration: SessionConfiguration;
  epoch: number;
  sequence: number;
  monitor: ReturnType<typeof monitorRoute>;
  queue: Promise<unknown>;
  pendingReceipts: Set<CommandId>;
};

export function selectRoute(options: Options) {
  const { expectedIdentity: pin, clock, credentials } = options;
  if (
    !v.is(EnvironmentIdentitySchema, pin) ||
    !sameEnvironmentIdentity(pin, credentials.identity) ||
    credentials.principal.deviceId !== credentials.signer.deviceId
  )
    throw new Error("Registration does not match the pinned environment");
  function routesFor(input: readonly Route[]) {
    const read = migrateRouteCatalog({
      formatVersion: 1,
      environments: [
        { environmentId: pin.id, pinnedIdentity: pin, preferredRouteId: null, routes: input },
      ],
    });
    if (read.kind !== "ready") throw new Error("Invalid route catalog");
    return read.catalog.environments.flatMap((entry) => entry.routes);
  }
  let routes = routesFor(options.orderedRoutes);
  let generation = options.activeEpoch;
  let sender: Sender | null = null;
  let closed = false;
  let revoked = false;
  let failures = 0;
  const quarantined = new Set<RouteId>();
  const statuses = new Map<RouteId, RouteStatus>(routes.map((route) => [route.id, route.status]));
  const retry = new Deadline(clock);
  const stable = new Deadline(clock);
  let retryPending = false;
  let selecting = false;
  let cancelRound = () => {};
  const emit = (e: RouteEvent) => options.observe?.(e);
  function status(id: RouteId, value: RouteStatus) {
    statuses.set(id, value);
    emit({ kind: "route", routeId: id, status: value });
  }
  function release(code: number) {
    if (!sender) return;
    const old = sender;
    sender = null;
    stable.clear();
    old.monitor.close();
    old.attempt.close(code);
    emit({ kind: "disconnected", routeId: old.attempt.route.id });
  }
  function scheduleRetry() {
    if (
      sender ||
      closed ||
      revoked ||
      selecting ||
      retryPending ||
      routes.every((route) => quarantined.has(route.id))
    )
      return;
    const bytes = options.random.bytes(4);
    const sample = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0) / 2 ** 32;
    retryPending = true;
    retry.set(retryDelay(failures++, sample), () => begin(false));
  }
  function begin(manual: boolean) {
    if (closed || revoked) return;
    cancelRound();
    retry.clear();
    retryPending = false;
    if (manual) quarantined.clear();
    selecting = true;
    const epoch = generation++;
    const queue = routes.filter((route) => !quarantined.has(route.id));
    const attempts = new Set<RouteAttempt>();
    const verified = new Set<RouteAttempt>();
    const priority = new Deadline(clock);
    const batch = new Deadline(clock);
    let selected: RouteAttempt | null = null;
    let released = false;
    let cancelled = false;
    let next = 0;
    cancelRound = () => {
      cancelled = true;
      selecting = false;
      priority.clear();
      batch.clear();
      for (const attempt of attempts) {
        attempt.close();
        if (statuses.get(attempt.route.id)?.kind === "probing")
          status(attempt.route.id, { kind: "untested" });
      }
      attempts.clear();
    };
    function fill() {
      if (cancelled || selected || verified.size) return;
      while (next < queue.length && attempts.size < (released ? limits.maxConcurrentProbes : 1)) {
        const route = queue[next++];
        if (route) start(route);
        if (cancelled || selected || verified.size) break;
      }
      if (!attempts.size && next === queue.length) {
        selecting = false;
        scheduleRetry();
      }
    }
    function choose() {
      if (cancelled || selected) return;
      for (const attempt of attempts) {
        if (!verified.has(attempt)) continue;
        selected = attempt;
        priority.clear();
        for (const other of verified)
          if (other !== attempt) {
            other.close();
            attempts.delete(other);
          }
        verified.clear();
        void attempt.authenticate(options.features);
        return;
      }
    }
    function diagnose(route: Route, detail: TrustDetail) {
      const result = v.safeParse(RouteDiagnosticSchema, {
        routeId: route.id,
        environmentId: pin.id,
        observedAt: clock.utcMilliseconds(),
        detail,
      });
      if (result.success) emit({ kind: "diagnostic", diagnostic: result.output });
    }
    function start(route: Route) {
      const pendingReceipts = new Set<CommandId>();
      const attempt = new RouteAttempt(route, pin, options, {
        verified() {
          if (cancelled) return;
          status(route.id, { kind: "reachable", checkedAt: clock.utcMilliseconds() });
          if (selected) {
            attempt.close();
            attempts.delete(attempt);
            return;
          }
          verified.add(attempt);
          if (verified.size === 1) batch.set(0, choose);
        },
        authorized(authorized) {
          if (!cancelled) emit({ kind: "authorized", routeId: route.id, authorized });
        },
        configured(hello, configuration, expected) {
          if (cancelled || selected !== attempt) return;
          attempts.delete(attempt);
          selecting = false;
          const previous = sender;
          const monitor = monitorRoute(
            clock,
            (serial) => attempt.send({ kind: "transport.probe", serial }),
            () => {
              if (sender?.attempt !== attempt) return;
              release(BUSINESS_CLOSE_CODES.normal);
              status(route.id, {
                kind: "unavailable",
                checkedAt: clock.utcMilliseconds(),
                reason: "noResponse",
              });
              scheduleRetry();
            },
          );
          sender = {
            attempt,
            hello,
            configuration,
            expected,
            epoch,
            monitor,
            sequence: 1,
            queue: Promise.resolve(),
            pendingReceipts,
          };
          stable.set(limits.stableResetMs, () => {
            failures = 0;
          });
          previous?.monitor.close();
          previous?.attempt.close(BUSINESS_CLOSE_CODES.normal);
          emit({ kind: "sender", routeId: route.id, hello, configuration, epoch });
        },
        frame(raw) {
          const receipt = v.safeParse(CommandReceiptSchema, raw);
          if (
            receipt.success &&
            receipt.output.kind === "accepted" &&
            receipt.output.result.kind === "textReturned"
          ) {
            if (
              sender?.attempt === attempt &&
              receipt.output.result.target.environmentId === pin.id
            )
              emit({
                kind: "textReturned",
                commandId: receipt.output.commandId,
                result: receipt.output.result,
              });
            return;
          }
          if (receipt.success && pendingReceipts.delete(receipt.output.commandId)) {
            emit({ kind: "receipt", receipt: receipt.output });
            return;
          }
          if (sender?.attempt !== attempt) return;
          const parsed = v.safeParse(ControlMessageSchema, raw);
          if (!parsed.success) return;
          const frame = parsed.output;
          if (frame.kind === "transport.echo") sender.monitor.echo(frame.serial);
          else if (frame.kind === "transport.probe")
            attempt.send({ kind: "transport.echo", serial: frame.serial });
          else if (frame.kind.startsWith("subscription.")) emit({ kind: "control", epoch, frame });
        },
        failed(reason, detail) {
          const wasActive = sender?.attempt === attempt;
          if (wasActive) release(BUSINESS_CLOSE_CODES.normal);
          if (cancelled && !wasActive) return;
          attempts.delete(attempt);
          verified.delete(attempt);
          if (detail || typeof reason === "object") quarantined.add(route.id);
          if (detail) diagnose(route, detail);
          if (detail?.stage === "protocolVersion")
            status(route.id, { kind: "reachable", checkedAt: clock.utcMilliseconds() });
          else
            status(route.id, { kind: "unavailable", checkedAt: clock.utcMilliseconds(), reason });
          if (
            reason === "revoked" ||
            (detail?.stage === "authentication" && detail.reason === "revokedKey")
          ) {
            revoked = true;
            cancelRound();
            release(BUSINESS_CLOSE_CODES.revoked);
            return;
          }
          if (!cancelled && selected === attempt) selecting = false;
          if (wasActive || selected === attempt) {
            scheduleRetry();
            return;
          }
          released = true;
          priority.clear();
          fill();
        },
      });
      attempts.add(attempt);
      status(route.id, { kind: "probing", startedAt: clock.utcMilliseconds() });
      attempt.open();
    }
    priority.set(limits.preferredHeadStartMs, () => {
      released = true;
      fill();
    });
    fill();
  }
  begin(false);
  return {
    status: (id: RouteId) => statuses.get(id),
    hostStatus: () => describeHost(null, null),
    get active() {
      return (
        sender && {
          routeId: sender.attempt.route.id,
          configuration: sender.configuration,
          epoch: sender.epoch,
        }
      );
    },
    setCandidates(input: readonly Route[]) {
      const previous = routes;
      routes = routesFor(input);
      const retained = (old: Route) =>
        routes.some((r) => r.id === old.id && r.endpoint === old.endpoint && r.kind === old.kind);
      if (previous.some((old) => !retained(old))) {
        cancelRound();
        if (sender && !retained(sender.attempt.route)) release(BUSINESS_CLOSE_CODES.normal);
        for (const old of previous)
          if (!retained(old)) {
            statuses.delete(old.id);
            quarantined.delete(old.id);
          }
        if (!sender) begin(false);
      } else if (!sender && !selecting && !retryPending && routes.length > previous.length)
        begin(false);
      for (const route of routes) if (!statuses.has(route.id)) status(route.id, route.status);
    },
    retry() {
      begin(true);
    },
    foreground() {
      if (sender) sender.monitor.foreground();
      else if (retryPending && retry.expired()) {
        retry.clear();
        retryPending = false;
        scheduleRetry();
      }
    },
    async send(input: RouteCommand) {
      const command: RouteCommand = JSON.parse(canonicalJson(input));
      const current = sender;
      if (!current) return false;
      async function sendOn(session: Sender) {
        if (sender !== session) return false;
        const { hello, expected } = session;
        const unsigned = {
          kind: "signedRequest",
          ...command,
          environmentId: pin.id,
          connectionId: hello.connectionId,
          challengeId: hello.challengeId,
          challenge: hello.challenge,
          protocolVersion: expected.protocolVersion,
          signer: expected.signer,
          sequence: session.sequence + 1,
        };
        const signature = await credentials.sign(canonicalJson(unsigned));
        if (sender !== session) return false;
        session.sequence++;
        session.pendingReceipts.add(command.commandId);
        return session.attempt.send({ ...unsigned, signature });
      }
      const result = current.queue.then(() => sendOn(current));
      current.queue = result.catch(() => false);
      return result;
    },
    close() {
      closed = true;
      cancelRound();
      retry.clear();
      release(BUSINESS_CLOSE_CODES.normal);
    },
  };
}
export type RouteSelector = ReturnType<typeof selectRoute>;
export type { RoutePlatform, RouteDial, RouteCredentials, SocketEvent } from "./route-attempt";
export type { RouteClock } from "./route-timers";
