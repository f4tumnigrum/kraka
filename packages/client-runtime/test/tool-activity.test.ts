import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  binarySource,
  ClientAuthenticationSchema,
  ContentTransferIdSchema,
  decodeFrame,
  FlowPeer,
  ProtocolFeatureSetSchema,
  ServerHelloSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  SignedRequestSchema,
  SubscriptionIdSchema,
  ToolActivityBodySchema,
  ToolActivityDetailFrameSchema,
  ToolActivityHistoryItemSchema,
  TRANSPORT_LIMITS,
  wireBytes,
  type AuthorizationExpectation,
  type ClientAuthentication,
  type FlowPort,
  type ToolActivityDetailFrame,
} from "@kraka/protocol";
import { ThreadReplica } from "../src/thread-replica";
import { emptyThreadCache, type ThreadCache, type ThreadCacheStore } from "../src/thread-pass";
import type { ToolActivityView } from "../src/tool-activity";

const features = v.parse(ProtocolFeatureSetSchema, [
  "strictSchemas",
  "signedRequests",
  "objectReplacementSync",
  "perStreamFlowControl",
  "binaryContentChunks",
  "timelineItems",
]);
const hello = v.parse(ServerHelloSchema, {
  kind: "server.hello",
  connectionId: "epoch",
  challengeId: "challenge-id",
  challenge: "a".repeat(43),
  clientNonce: "b".repeat(43),
  protocolVersion: { major: 1, minor: 1 },
  features,
  identity: { id: "environment", publicKey: "c".repeat(87), keyVersion: 1 },
  identityProof: "d".repeat(86),
});
const principal = { kind: "device" as const, id: "owner", ownerId: "owner", deviceId: "device" };
const signer = { kind: "device" as const, deviceId: "device", keyId: "key" };
const authorized = v.parse(SessionAuthorizedSchema, {
  kind: "session.authorized",
  environmentId: "environment",
  connectionId: "epoch",
  environmentSessionId: "session",
  principal,
  signer,
  authorizedAt: 1,
  protocolVersion: hello.protocolVersion,
  features,
});
const expected: AuthorizationExpectation = authorized;
const configuration = v.parse(SessionConfigurationSchema, {
  kind: "session.configuration",
  connectionId: "epoch",
  environmentSessionId: "session",
  environment: { id: "environment", version: "1" },
  version: "1",
  transportLimits: TRANSPORT_LIMITS,
  executors: [],
});
const utf8 = {
  encode: (text: string) => new TextEncoder().encode(text),
  decode: (bytes: Uint8Array) => new TextDecoder().decode(bytes),
};
const monotonic = { now: () => performance.now() };
async function sha256(bytes: Uint8Array) {
  const copy = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(copy).set(bytes);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", copy));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

test("expansion follows complete versioned bodies and detaches only its own viewer", async () => {
  let replica: ThreadReplica;
  let server: FlowPeer;
  let nextSequence = 1;
  let responseStreamId = 0;
  let responseSubscriptionId = v.parse(SubscriptionIdSchema, "viewer");
  let queued: ToolActivityDetailFrame[] = [];
  let current: {
    frame: ToolActivityDetailFrame;
    bytes: Uint8Array;
    headerSent: boolean;
    declared: boolean;
    chunk: ReturnType<typeof binarySource> | null;
    complete: boolean;
  } | null = null;
  const bodies = new Map<string, Uint8Array>();
  let requestedDetach = false;
  let responseStream = 0;

  const clientPort: FlowPort = {
    utf8,
    now: monotonic.now,
    write(data) {
      server.input(data);
      queueMicrotask(() => server.pump());
      return 1;
    },
  };
  const serverPort: FlowPort = {
    utf8,
    now: monotonic.now,
    write(data) {
      const frame = decodeFrame(data, utf8);
      const size = wireBytes(data, utf8);
      if (frame.lane === "control" && frame.message.kind === "server.hello") {
        queueMicrotask(() => replica.authenticate(frame, size, authentication));
      } else {
        replica.peer.input(data);
        queueMicrotask(() => replica.peer.pump());
      }
      return 1;
    },
  };
  const authentication: ClientAuthentication = v.parse(ClientAuthenticationSchema, {
    kind: "client.authenticate",
    protocolVersion: hello.protocolVersion,
    environmentId: "environment",
    connectionId: hello.connectionId,
    challengeId: hello.challengeId,
    challenge: hello.challenge,
    clientNonce: hello.clientNonce,
    signer,
    sequence: 1,
    features,
    method: "session.authenticate",
    signature: "e".repeat(86),
  });
  let cache: ThreadCache = emptyThreadCache();
  const store: ThreadCacheStore = {
    async transact(edit) {
      const { next, result } = edit(cache);
      cache = next;
      return result;
    },
  };
  server = new FlowPeer(hello.connectionId, serverPort, {
    control(message) {
      if (message.kind === "client.authenticate") {
        server.control(authorized);
        server.control(configuration);
        server.pump();
        return;
      }
      if (message.kind === "signedRequest" && message.method === "tool.readActivity") {
        responseStreamId = message.payload.streamId;
        responseSubscriptionId = message.payload.subscriptionId;
        server.control({
          kind: "accepted",
          commandId: message.commandId,
          result: {
            kind: "activityReadStarted",
            subscriptionId: responseSubscriptionId,
            streamId: responseStreamId,
          },
        });
        responseStream = server.send.open(responseSubscriptionId, (offset, capacity) => {
          if (current?.complete) {
            current = null;
            if (queued.length === 0) return null;
          }
          if (!current) {
            const frame = queued.shift();
            if (!frame) return null;
            current = {
              frame,
              bytes: frameBody(frame.reference.version),
              headerSent: false,
              declared: false,
              chunk: null,
              complete: false,
            };
          }
          if (!current.headerSent) {
            const header = {
              lane: "data" as const,
              epoch: hello.connectionId,
              streamId: responseStreamId,
              offsetBytes: offset,
              message: current.frame,
            };
            if (wireBytes(JSON.stringify(header), utf8) > capacity) return null;
            current.headerSent = true;
            return header;
          }
          if (!current.declared) {
            if (
              !server.send.control({
                kind: "transport.content",
                transferId: current.frame.transferId,
                streamId: responseStreamId,
                byteLength: current.bytes.length,
                encoding: "utf8Json",
              })
            )
              return null;
            current.declared = true;
            current.chunk = binarySource({
              epoch: hello.connectionId,
              streamId: responseStreamId,
              transferId: current.frame.transferId,
              length: current.bytes.length,
              utf8,
              read(start, length) {
                const bytes = current!.bytes.subarray(start, start + length);
                if (start + length === current!.bytes.length) current!.complete = true;
                return bytes;
              },
            });
            return null;
          }
          return current.chunk?.(offset, capacity) ?? null;
        });
        if (responseStream !== responseStreamId) throw Error("Unexpected detail stream ID");
        server.pump();
        return;
      }
      if (message.kind === "signedRequest" && message.method === "subscription.close") {
        requestedDetach = true;
        server.control({
          kind: "accepted",
          commandId: message.commandId,
          result: { kind: "actionAccepted" },
        });
        server.send.end(responseStream, "clientClosed");
        server.pump();
      }
    },
    data() {},
    discarded() {},
  });
  let commandId = 0;
  replica = new ThreadReplica(hello, expected, clientPort, {
    store,
    sha256,
    read: () => cache,
    sign(method, payload) {
      return v.parse(SignedRequestSchema, {
        kind: "signedRequest",
        protocolVersion: hello.protocolVersion,
        environmentId: "environment",
        connectionId: hello.connectionId,
        challengeId: hello.challengeId,
        challenge: hello.challenge,
        signer,
        sequence: ++nextSequence,
        commandId: `command-${++commandId}`,
        method,
        payload,
        signature: "e".repeat(86),
      });
    },
    id: () => responseSubscriptionId,
  });
  server.control(hello);
  server.pump();
  await replica.ready;

  const item = v.parse(ToolActivityHistoryItemSchema, {
    kind: "toolActivity",
    id: "item",
    threadId: "thread",
    source: {
      instanceId: "codex",
      nativeSessionId: "session",
      epoch: 1,
      eventId: "event-1",
      sourceId: "call",
      callId: "call",
    },
    assignment: {
      kind: "attempt",
      attemptId: "attempt",
      relationship: { kind: "root", nativeRootTurnId: "root" },
    },
    phase: "progress",
    inputSummary: "printf amber",
    outputSummary: "amber",
    createdAt: 10,
    createdPosition: "1",
    version: "1",
  });
  const firstBody = v.parse(ToolActivityBodySchema, {
    input: { kind: "captured", json: JSON.stringify({ command: "printf amber" }) },
    output: { kind: "partial", text: "amber", truncated: false },
    status: "running",
    exitCode: null,
    success: null,
    changes: [],
  });
  const nextItem = v.parse(ToolActivityHistoryItemSchema, {
    ...item,
    phase: "progress",
    outputSummary: "amber\n",
    version: "2",
  });
  const nextBody = v.parse(ToolActivityBodySchema, {
    ...firstBody,
    output: { kind: "partial", text: "amber\n", truncated: false },
  });
  async function detail(itemVersion: typeof item, body: typeof firstBody) {
    const bytes = utf8.encode(JSON.stringify({ item: itemVersion, body }));
    bodies.set(itemVersion.version, bytes);
    return v.parse(ToolActivityDetailFrameSchema, {
      kind: "tool.activity.detail",
      subscriptionId: responseSubscriptionId,
      reference: {
        threadId: itemVersion.threadId,
        itemId: itemVersion.id,
        version: itemVersion.version,
        byteLength: bytes.length,
        sha256: await sha256(bytes),
      },
      transferId: v.parse(ContentTransferIdSchema, `transfer-${itemVersion.version}`),
    });
  }
  function frameBody(version: string) {
    const body = bodies.get(version);
    if (!body) throw Error(`Missing body version ${version}`);
    return body;
  }
  queued.push(await detail(item, firstBody));
  const first = Promise.withResolvers<ToolActivityView>();
  const second = Promise.withResolvers<ToolActivityView>();
  const opened = await replica.readActivity({
    threadId: item.threadId,
    itemId: item.id,
    expectedVersion: item.version,
    onVersion(view) {
      if (view.item.version === "1") first.resolve(view);
      if (view.item.version === "2") second.resolve(view);
    },
  });
  expect(opened.kind).toBe("opened");
  if (opened.kind !== "opened") throw Error("Expected an activity viewer");
  expect((await first.promise).body.output).toEqual({
    kind: "partial",
    text: "amber",
    truncated: false,
  });
  queued.push(await detail(nextItem, nextBody));
  server.pump();
  expect((await second.promise).body.output).toEqual({
    kind: "partial",
    text: "amber\n",
    truncated: false,
  });
  await opened.close();
  expect(requestedDetach).toBe(true);
  replica.close();
});
