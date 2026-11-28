import * as v from "valibot";
import {
  canonicalJson,
  ClientAuthenticationSchema,
  ControlMessageSchema,
  decodeFrame,
  SignedRequestSchema,
  SubscriptionIdSchema,
  wireBytes,
  type HistoryRow,
  type Route,
  type RegisteredDevice,
  type TodoReplyRecord,
  type SyncCursor,
  type ThreadId,
  type TransportFrame,
  type WireMessage,
  type SubscriptionId,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  selectRoute,
  ThreadReplica,
  scopeKey,
  type SessionSnapshot,
  type ThreadCache,
  type ThreadCacheStore,
  type ThreadInstallation,
  type RouteDial,
} from "../src";

export type InstalledThread = {
  kind: "installed";
  environmentId: RegisteredDevice["identity"]["id"];
  deviceId: RegisteredDevice["deviceId"];
  threadId: ThreadId;
  connectionId: string;
  subscriptionId: SubscriptionId;
  after: SyncCursor | null;
  head: SyncCursor;
  rows: HistoryRow[];
  answers: TodoReplyRecord[];
};

const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const utf8 = {
  encode: (s: string) => encoder.encode(s),
  decode: (b: Uint8Array) => decoder.decode(b),
};

export function observeNativeThread(options: {
  registration: RegisteredDevice;
  sign: (text: string) => Promise<string>;
  route: Route;
  threadId: ThreadId;
  store: ThreadCacheStore & { read(): ThreadCache };
  installed(record: InstalledThread): void;
  failed(error: Error): void;
  snapshot?(state: SessionSnapshot): void;
}) {
  const { registration, route, threadId, store } = options;
  let phase: SessionSnapshot = { phase: "opening", generation: 1 };
  let active: ThreadReplica | undefined;
  let currentInstallation: ThreadInstallation | undefined;
  let authorization: Extract<SessionSnapshot, { phase: "sendable" }>["authorization"] | undefined;
  const sockets = new Map<string, ThreadReplica>();
  const set = (s: SessionSnapshot) => {
    phase = s;
    options.snapshot?.(s);
  };
  function openThread(replica: ThreadReplica) {
    const cached = store.read().scopes[canonicalJson({ kind: "thread", threadId })]?.cursor ?? null;
    void replica.ready
      .then(() => replica.open(threadId, cached))
      .then(async (opened) => {
        if ((await opened.receipt).kind !== "accepted") throw Error("Thread unavailable");
      })
      .catch((e: Error) => {
        if (active === replica) options.failed(e);
      });
  }
  const dial: RouteDial = (url, receive) => {
    const socket = new WebSocket(url, "kraka.thread.v1");
    socket.binaryType = "arraybuffer";
    let first: Extract<TransportFrame, { lane: "control" }> | undefined,
      size = 0;
    let replica: ThreadReplica | undefined, installation: ThreadInstallation | undefined;
    let ended = false;
    let publish = Promise.resolve();
    const answers = new Map<string, TodoReplyRecord>();
    const snapshots = new Map<string, InstalledThread>();
    function dispose() {
      ended = true;
      if (replica) {
        sockets.delete(replica.hello.connectionId);
        replica.close();
      }
    }
    socket.onclose = ({ code }) => {
      dispose();
      receive({ kind: "closed", code });
    };
    socket.onerror = () => receive({ kind: "closed" });
    socket.onmessage = ({ data }) => {
      if (ended) return;
      try {
        const wire: WireMessage = typeof data === "string" ? data : new Uint8Array(data);
        if (replica) {
          replica.peer.input(wire);
          replica.peer.pump();
          return;
        }
        const frame = decodeFrame(wire, utf8);
        if (
          first ||
          frame.lane !== "control" ||
          frame.message.kind !== "server.hello" ||
          frame.epoch !== frame.message.connectionId
        )
          throw Error("Invalid thread hello");
        first = frame;
        size = wireBytes(wire, utf8);
        receive({ kind: "frame", value: frame.message });
      } catch {
        socket.close(4000);
      }
    };
    return {
      close(code) {
        dispose();
        socket.close(code);
      },
      send(raw) {
        if (replica) {
          const control = v.parse(ControlMessageSchema, raw);
          if (control.kind !== "transport.probe" && control.kind !== "transport.echo")
            throw Error("Unexpected route control");
          replica.peer.control(control);
          replica.peer.pump();
          return;
        }
        const auth = v.parse(ClientAuthenticationSchema, raw);
        if (!first || first.message.kind !== "server.hello") throw Error("Missing verified hello");
        const hello = first.message;
        let sequence = 1;
        replica = new ThreadReplica(
          hello,
          { ...auth, principal: registration.principal },
          {
            utf8,
            now: () => performance.now(),
            write(w) {
              socket.send(w);
              return 1;
            },
          },
          {
            store,
            read: () => store.read(),
            id: () => v.parse(SubscriptionIdSchema, crypto.randomUUID()),
            handshake(frame) {
              receive({ kind: "frame", value: frame });
            },
            received(kind, frame) {
              if (kind === "transport.echo") receive({ kind: "frame", value: frame });
            },
            staleBase() {
              if (!ended && replica && active === replica) openThread(replica);
            },
            opened(sub) {
              installation = sub;
              if (active === replica) currentInstallation = sub;
            },
            async sign(method, payload, commandId) {
              if (ended || active !== replica || phase.phase !== "sendable")
                throw Error("Thread disconnected");
              const fields = {
                kind: "signedRequest",
                method,
                payload,
                commandId: commandId ?? crypto.randomUUID(),
                protocolVersion: auth.protocolVersion,
                environmentId: auth.environmentId,
                connectionId: hello.connectionId,
                challenge: hello.challenge,
                challengeId: hello.challengeId,
                signer: auth.signer,
                sequence: ++sequence,
              };
              const signature = await options.sign(canonicalJson(fields));
              if (ended || active !== replica) throw Error("Thread disconnected");
              return v.parse(SignedRequestSchema, { ...fields, signature });
            },
            installed(head) {
              if (!installation || head.scope.kind !== "thread" || head.scope.threadId !== threadId)
                return;
              const cache = store.read(),
                members = cache.scopes[scopeKey(head)]?.members ?? {};
              const rows = Object.keys(members).flatMap((key) => cache.rows[key]?.row ?? []);
              snapshots.set(head.through, {
                kind: "installed",
                head,
                rows,
                threadId,
                environmentId: hello.identity.id,
                deviceId: registration.deviceId,
                connectionId: hello.connectionId,
                answers: [],
                subscriptionId: installation.state.request.payload.subscriptionId,
                after: installation.state.request.payload.after,
              });
            },
            acknowledged(head) {
              const record = snapshots.get(head.through);
              snapshots.delete(head.through);
              const current = replica;
              if (!record || !current || ended || active !== current) return;
              publish = publish
                .then(async () => {
                  for (const row of record.rows) {
                    if (
                      row.objectType !== "todoRequest" ||
                      row.value.state.kind !== "answered" ||
                      row.value.state.answer.content.kind !== "message"
                    )
                      continue;
                    const id = row.value.id;
                    let answer = answers.get(id);
                    if (!answer) {
                      const receipt = await current.rpc("todo.readAnswer", {
                        threadId,
                        todoRequestId: id,
                      });
                      if (
                        receipt.kind !== "accepted" ||
                        (receipt.result.kind !== "todoAnswerRead" &&
                          receipt.result.kind !== "executorAnswerRead") ||
                        receipt.result.todoRequestId !== id ||
                        receipt.result.messageId !== row.value.state.answer.content.messageId
                      )
                        continue;
                      answer = receipt.result;
                      answers.set(id, answer);
                    }
                    record.answers.push(answer);
                  }
                  if (!ended && active === current) options.installed(record);
                })
                .catch((e: Error) => {
                  if (!ended) options.failed(e);
                });
            },
          },
        );
        sockets.set(hello.connectionId, replica);
        void replica.ready.catch(() => {
          if (!ended) socket.close(4000);
        });
        replica.authenticate(first, size, auth);
      },
    };
  };
  const selector = selectRoute({
    expectedIdentity: registration.identity,
    orderedRoutes: [route],
    activeEpoch: 1,
    clock: {
      nowMilliseconds: () => performance.now(),
      utcMilliseconds: Date.now,
      after(ms, fn) {
        const t = setTimeout(fn, ms);
        return () => clearTimeout(t);
      },
    },
    random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    verify: verifyP256,
    dial,
    features: [
      "strictSchemas",
      "signedRequests",
      "objectReplacementSync",
      "perStreamFlowControl",
      "binaryContentChunks",
      "timelineItems",
    ],
    credentials: {
      identity: registration.identity,
      principal: registration.principal,
      signer: { kind: "device", keyId: registration.keyId, deviceId: registration.deviceId },
      sign: options.sign,
    },
    observe(event) {
      if (event.kind === "authorized") authorization = event.authorized;
      if (event.kind === "disconnected") {
        active = undefined;
        authorization = undefined;
        currentInstallation = undefined;
        set({ phase: "opening", generation: phase.generation + 1 });
      }
      if (event.kind === "route" && event.status.kind === "unavailable") {
        set({
          phase: "failed",
          generation: phase.generation,
          failure: { stage: "route", reason: event.status.reason },
        });
      }
      if (event.kind === "diagnostic")
        options.failed(Error("Route verification failed: " + event.diagnostic.detail.stage));
      if (event.kind !== "sender" || !authorization) return;
      const replica = sockets.get(event.hello.connectionId);
      if (!replica) throw Error("Missing authenticated thread connection");
      active = replica;
      set({
        phase: "sendable",
        generation: event.epoch,
        routeId: route.id,
        identity: event.hello.identity,
        connectionId: event.hello.connectionId,
        authorization,
        configuration: event.configuration,
      });
      openThread(replica);
    },
  });
  return {
    foreground: selector.foreground,
    close() {
      active = undefined;
      selector.close();
      set({ phase: "closed", generation: phase.generation });
    },
    snapshot: () => phase,
    current: () =>
      !!active && phase.phase === "sendable" && currentInstallation?.state.status === "current",
  };
}
