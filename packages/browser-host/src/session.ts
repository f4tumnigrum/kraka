import * as v from "valibot";
import {
  canonicalHttpOrigin,
  canonicalJson,
  CommandReceiptSchema,
  PairingPendingSchema,
  PairingChallengeSchema,
  DevicePairingResultSchema,
  type PairingExchange,
  type PendingRegistration,
  type CommandId,
  type RegisteredDevice,
  type ServerHello,
  ROUTE_LIMITS,
  type SessionAuthorized,
  type RouteCatalogRead,
} from "@kraka/protocol";
import {
  RouteAttempt,
  selectBrowserRoute,
  sameEnvironmentIdentity,
  unavailableOnlineRead,
  type OnlineReadResult,
  type SessionHandle,
  type SessionSnapshot,
} from "@kraka/client-runtime";
import type { BrowserSessionInput, BrowserPlatform } from "./index";
import { createBrowserPlatform, readBrowserCatalog, decode64, pairingDisplays } from "./storage";

const utf8 = new TextEncoder();
export { browserSocketFactory } from "./control-socket";
type Failure = Extract<SessionSnapshot, { phase: "failed" }>["failure"];
type WithoutGeneration<T> = T extends SessionSnapshot ? Omit<T, "generation"> : never;
type Phase = WithoutGeneration<SessionSnapshot>;

function exchangePending(
  platform: BrowserPlatform,
  attempt: RouteAttempt,
  hello: ServerHello,
  pending: PendingRegistration,
  active: () => boolean,
  completed: () => void,
  fail: (failure: Failure) => void,
) {
  let stage: "request" | "challenge" | "completion" = "request";
  let claimed = pending;
  let chain = Promise.resolve();
  async function receive(raw: unknown) {
    if (!active()) return;
    const reply = v.safeParse(DevicePairingResultSchema, raw);
    if (reply.success && reply.output.kind === "pairing.rejected") throw Error(reply.output.reason);
    if (stage === "request") {
      const msg = v.parse(PairingPendingSchema, raw);
      if (
        msg.environmentId !== pending.identity.id ||
        msg.inviteId !== pending.inviteId ||
        msg.requestId !== pending.requestId ||
        msg.deviceId !== pending.deviceId ||
        msg.publicKey !== pending.publicKey ||
        canonicalJson(msg.target) !== canonicalJson(pending.target) ||
        canonicalJson(msg.permissions) !== canonicalJson(pending.requestedPermissions)
      )
        throw Error("pairingSummaryMismatch");
      pairingDisplays.get(platform.credentials)?.(msg);
      stage = "challenge";
    } else if (stage === "challenge") {
      const challenge = v.parse(PairingChallengeSchema, raw);
      const result = await platform.credentials.selectClaim(pending, challenge);
      if (!active()) return;
      if (result !== "stored" && result !== "unchanged")
        return fail({
          stage: "credentials",
          reason: result === "conflict" ? "corruptRecord" : "storageUnavailable",
        });
      claimed = { ...pending, claimId: challenge.claimId };
      const fields: Omit<PairingExchange, "signature"> = {
        kind: "pairing.exchange",
        method: "pairing.exchange",
        protocolVersion: { major: 1, minor: 0 },
        environmentId: hello.identity.id,
        inviteId: pending.inviteId,
        requestId: pending.requestId,
        claimId: challenge.claimId,
        deviceId: pending.deviceId,
        deviceKeyId: pending.keyId,
        publicKey: pending.publicKey,
        challengeId: challenge.challengeId,
        challenge: challenge.challenge,
        sequence: 1,
      };
      const signature = await platform.credentials.sign(
        pending.keyId,
        utf8.encode(canonicalJson(fields)),
      );
      if (!active()) return;
      stage = "completion";
      attempt.send({ ...fields, signature });
    } else {
      if (!reply.success || reply.output.kind !== "pairing.completed")
        throw Error("unexpectedPairingReply");
      const result = await platform.credentials.complete(claimed, hello.identity, reply.output);
      if (!active()) return;
      if (result !== "stored" && result !== "alreadyRegistered")
        return fail({
          stage: "credentials",
          reason: result === "conflict" ? "corruptRecord" : "storageUnavailable",
        });
      completed();
    }
  }
  attempt.stayPublic((raw) => {
    chain = chain
      .then(() => receive(raw))
      .catch((error) =>
        fail({
          stage: "handshake",
          reason: error instanceof Error ? error.message : "invalidPairingReply",
        }),
      );
  });
  attempt.send({
    kind: "pairing.request",
    environmentId: pending.identity.id,
    inviteId: pending.inviteId,
    requestId: pending.requestId,
    deviceId: pending.deviceId,
    publicKey: pending.publicKey,
    target: pending.target,
    requestedPermissions: pending.requestedPermissions,
  });
}

let nextGeneration = 0;
export function openSession(
  input: BrowserSessionInput,
  features?: ServerHello["features"],
): SessionHandle {
  const platform = createBrowserPlatform(input.credentials, input.socketFactory);
  const page = platform.page();
  let generation = ++nextGeneration;
  let state: SessionSnapshot = { generation, phase: "opening" };
  const listeners = new Set<(value: SessionSnapshot) => void>();
  const notifications: SessionSnapshot[] = [];
  let notifying = false;
  const pending = new Map<CommandId, (value: OnlineReadResult) => void>();
  let current: RouteAttempt | undefined;
  let authority:
    | {
        hello: ServerHello;
        registered: RegisteredDevice;
        authorization: SessionAuthorized;
        sequence: number;
        attempt: RouteAttempt;
      }
    | undefined;
  let writes = Promise.resolve();
  const live = () => state.phase !== "closed" && state.phase !== "failed";
  function publish(phase: Phase) {
    state = { ...phase, generation };
    notifications.push(state);
    if (notifying) return;
    notifying = true;
    try {
      for (let next = notifications.shift(); next; next = notifications.shift()) {
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try {
            listener(next);
          } catch (error) {
            globalThis.reportError(error);
          }
        }
        if (next.phase === "closed") listeners.clear();
      }
    } finally {
      notifying = false;
    }
  }
  function stop() {
    authority = undefined;
    current?.close(1000);
    for (const [commandId, resolve] of pending) resolve({ kind: "unconfirmed", commandId });
    pending.clear();
  }
  function fail(failure: Failure) {
    if (!live()) return;
    stop();
    publish({ phase: "failed", failure });
  }
  async function open() {
    const options = {
      actualOrigin: page.origin,
      pageOrigin: input.pageOrigin,
      secureContext: page.secureContext,
      subtleAvailable: page.subtleAvailable,
      expectedIdentity: input.expectedIdentity,
      selectedEnvironmentId: input.expectedIdentity.id,
      offeredCatalog: input.routeCatalog,
      generation,
    };
    const check = (catalog: RouteCatalogRead) => selectBrowserRoute({ ...options, catalog }, URL);
    const beforeStorage = check({ kind: "invalidCatalog" });
    if (beforeStorage.kind === "unavailable" && beforeStorage.reason !== "invalidCatalog")
      return fail({ stage: "preDial", reason: beforeStorage.reason });
    if (
      canonicalHttpOrigin(input.credentials.origin, URL) !== page.origin ||
      input.credentials.environmentId !== input.expectedIdentity.id
    )
      return fail({ stage: "preDial", reason: "originMismatch" });
    const catalog = await readBrowserCatalog();
    if (!live()) return;
    const selection = check(catalog);
    if (selection.kind === "unavailable") {
      if (selection.reason === "pairingRequired")
        return publish({ phase: "unpaired", reason: "pairingRequired" });
      return fail({ stage: "preDial", reason: selection.reason });
    }
    const found = await platform.credentials.discover(selection.environmentId);
    if (!live()) return;
    if (found.kind === "storageUnavailable" || found.kind === "corruptRecord")
      return fail({ stage: "credentials", reason: found.kind });
    if (found.kind === "keyMissing" || found.kind === "keyUnusable")
      return publish({ phase: "unpaired", reason: found.kind });
    const registration = found.kind === "available" ? found.registration : null;
    if (registration && !sameEnvironmentIdentity(registration.identity, input.expectedIdentity))
      return fail({ stage: "credentials", reason: "corruptRecord" });
    const registered = registration?.kind === "registered" ? registration : null;
    const credentials = registered
      ? {
          identity: registered.identity,
          principal: registered.principal,
          signer: {
            kind: "device" as const,
            deviceId: registered.deviceId,
            keyId: registered.keyId,
          },
          sign: (canonical: string) =>
            platform.credentials.sign(registered.keyId, utf8.encode(canonical)),
        }
      : null;
    const route = input.routeCatalog.environments
      .find((e) => e.environmentId === selection.environmentId)
      ?.routes.find((r) => r.id === selection.routeId);
    if (!route) return fail({ stage: "preDial", reason: "catalogChanged" });
    let hello: ServerHello | undefined;
    let authorized: SessionAuthorized | undefined;
    const attempt: RouteAttempt = new RouteAttempt(
      route,
      input.expectedIdentity,
      {
        credentials,
        random: platform.random,
        clock: {
          ...platform.monotonic,
          utcMilliseconds: platform.utcMilliseconds,
          after(ms, run) {
            const id = setTimeout(run, ms);
            return () => clearTimeout(id);
          },
        },
        verify: (key, canonical, signature) =>
          platform.verify(key, utf8.encode(canonical), decode64(signature)),
        dial(url, receive) {
          const socket = platform.socketFactory(url, (event) => {
            if (event.kind === "open") return;
            if (event.kind === "close" || event.kind === "error")
              return receive({
                kind: "closed",
                ...(event.kind === "close" ? { code: event.code } : {}),
              });
            try {
              receive({
                kind: "frame",
                value: typeof event.data === "string" ? JSON.parse(event.data) : undefined,
              });
            } catch {
              receive({ kind: "closed" });
            }
          });
          return {
            close: (code) => socket.close(code),
            send: (frame) => socket.send(JSON.stringify(frame)),
          };
        },
      },
      {
        verified(value) {
          hello = value;
          publish({
            phase: "helloVerified",
            routeId: route.id,
            connectionId: value.connectionId,
            identity: value.identity,
            unpairedReason: registration
              ? registered
                ? null
                : "pendingExchange"
              : "notRegistered",
          });
          if (!live()) return;
          if (registered) void attempt.authenticate(features);
          else if (registration?.kind === "pendingExchange")
            exchangePending(
              platform,
              attempt,
              value,
              registration,
              () => live() && current === attempt,
              () => {
                attempt.close(1000);
                current = undefined;
                generation = ++nextGeneration;
                publish({ phase: "opening" });
                if (live())
                  void open().catch(() =>
                    fail({ stage: "credentials", reason: "storageUnavailable" }),
                  );
              },
              fail,
            );
          else
            attempt.stayPublic(() => fail({ stage: "handshake", reason: "unexpectedPublicFrame" }));
        },
        authorized(value) {
          if (!hello || !live()) return;
          authorized = value;
          publish({
            phase: "authorizedAwaitingConfiguration",
            routeId: route.id,
            identity: hello.identity,
            connectionId: hello.connectionId,
            authorization: value,
          });
        },
        configured(value, configuration) {
          if (!registered || !authorized || !live()) return;
          authority = { hello: value, registered, authorization: authorized, sequence: 1, attempt };
          publish({
            phase: "sendable",
            routeId: route.id,
            identity: value.identity,
            connectionId: value.connectionId,
            authorization: authorized,
            configuration,
          });
        },
        failed(reason, detail) {
          fail({
            stage: "route",
            reason,
            ...(detail
              ? {
                  diagnostic: {
                    environmentId: selection.environmentId,
                    routeId: route.id,
                    observedAt: Date.now(),
                    detail,
                  },
                }
              : {}),
          });
        },
        frame(raw) {
          if (!live() || current !== attempt) return;
          const receipt = v.safeParse(CommandReceiptSchema, raw);
          if (!receipt.success) return;
          const resolve = pending.get(receipt.output.commandId);
          pending.delete(receipt.output.commandId);
          resolve?.({ kind: "receipt", receipt: receipt.output });
        },
      },
    );
    current = attempt;
    attempt.open();
  }
  queueMicrotask(() => {
    if (live())
      void open().catch(() => fail({ stage: "credentials", reason: "storageUnavailable" }));
  });
  return {
    snapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      listener(state);
      return () => listeners.delete(listener);
    },
    async read(request) {
      const initial = authority;
      const unavailable = unavailableOnlineRead(state, request.commandId);
      if (unavailable) return unavailable;
      const { commandId } = request;
      const unconfirmed = { kind: "unconfirmed", commandId } as const;
      return new Promise<OnlineReadResult>((resolve) => {
        writes = writes
          .then(async () => {
            if (!initial || initial !== authority)
              return resolve(unavailableOnlineRead(state, commandId) ?? unconfirmed);
            if (pending.has(commandId)) return resolve(unconfirmed);
            const { hello, registered, authorization, attempt } = initial;
            const fields = {
              ...request,
              kind: "signedRequest",
              environmentId: hello.identity.id,
              connectionId: hello.connectionId,
              protocolVersion: authorization.protocolVersion,
              signer: authorization.signer,
              challengeId: hello.challengeId,
              challenge: hello.challenge,
              sequence: initial.sequence + 1,
            };
            const signature = await platform.credentials.sign(
              registered.keyId,
              utf8.encode(canonicalJson(fields)),
            );
            if (initial !== authority)
              return resolve(unavailableOnlineRead(state, commandId) ?? unconfirmed);
            const timer = setTimeout(() => {
              pending.delete(commandId);
              resolve(unconfirmed);
            }, ROUTE_LIMITS.noAnswerTimeoutMs);
            pending.set(commandId, (result) => {
              clearTimeout(timer);
              resolve(result);
            });
            if (attempt.send({ ...fields, signature })) initial.sequence++;
            else {
              clearTimeout(timer);
              pending.delete(commandId);
              resolve(unconfirmed);
            }
          })
          .catch(() => {
            fail({ stage: "connection", reason: "signingFailed" });
            resolve(unavailableOnlineRead(state, commandId) ?? unconfirmed);
          });
      });
    },
    close() {
      if (state.phase === "closed") return;
      stop();
      publish({ phase: "closed" });
    },
  };
}
