import { join } from "node:path";
import * as v from "valibot";
import { ThreadReplica, type ThreadCacheStore } from "../../packages/client-runtime/src";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { utf8 } from "../../packages/daemon/src/flow-socket";
import {
  base64url,
  canonicalJson,
  decodeFrame,
  wireBytes,
  ClientAuthenticationSchema,
  SignedRequestSchema,
  PrivateSecretRequestSchema,
  type PrivateSecretRequest,
  type CommandId,
  SubscriptionIdSchema,
  ThreadIdSchema,
  type SubscriptionPage,
  type SyncCursor,
  type EnvironmentIdentity,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import { startPairedProject, type Client } from "./paired-project";
import { startFirstSendFixture, productRoot } from "./first-send";
import { within, withState } from "./replay-process";

type Observation = { kind: string; message: unknown; at: number };
type Options = {
  holdSeal?: (head: SyncCursor) => Promise<void>;
  minor?: 0 | 1;
  captureReply?: (wire: import("@kraka/protocol").WireMessage) => void;
  timing?: (applyMs: number, persistMs: number) => void;
  timeline?: boolean;
  received?: (kind: string, message: unknown, at: number) => void;
  pageStaged?: (p: SubscriptionPage) => Promise<void> | void;
  store?: ThreadCacheStore;
  commandId?: (method: string) => string;
  acknowledged?: (head: SyncCursor) => void;
  installed?: (head: SyncCursor) => void;
};
export async function connectReplica(
  url: string,
  identity: EnvironmentIdentity,
  device: Client,
  cache: SqliteThreadCache,
  opts: Options = {},
) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const socket = new WebSocket(url.replace("/commands", "/ws") + "?nonce=" + nonce);
  socket.binaryType = "arraybuffer";
  const ready = Promise.withResolvers<ThreadReplica>(),
    closed = Promise.withResolvers<void>();
  let secret:
    | ((payload: PrivateSecretRequest["payload"], id: CommandId) => Promise<PrivateSecretRequest>)
    | undefined;
  let replica: ThreadReplica | undefined,
    seq = 0,
    bytes = 0,
    replyBytes = 0,
    arrival = 0;
  const messages: Observation[] = [],
    heads: SyncCursor[] = [];
  const signer = {
    kind: "device" as const,
    deviceId: device.device.deviceId,
    keyId: device.device.keyId,
  };
  const fail = (e: unknown) => {
    ready.reject(e);
    socket.terminate();
  };
  socket.onerror = () => fail(Error("Replica socket error"));
  socket.onclose = () => {
    replica?.close();
    ready.reject(Error("Replica socket closed"));
    closed.resolve();
  };
  let held: Promise<void> | null = null;
  socket.onmessage = async (e) => {
    arrival = performance.now();
    try {
      const wire = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      bytes += wireBytes(wire, utf8);
      replyBytes += wireBytes(wire, utf8);
      opts.captureReply?.(wire);
      if (replica) {
        if (held) await held;
        if (opts.holdSeal && typeof wire === "string") {
          const frame = decodeFrame(wire, utf8);
          if (frame.lane === "control" && frame.message.kind === "subscription.seal") {
            held = opts.holdSeal(frame.message.cursor);
            await held;
            held = null;
          }
        }
        replica.peer.input(wire);
        replica.peer.pump();
        return;
      }
      const frame = decodeFrame(wire, utf8);
      if (frame.lane !== "control" || frame.message.kind !== "server.hello")
        throw Error("Missing signed hello");
      const { identityProof, ...body } = frame.message;
      if (
        body.clientNonce !== nonce ||
        canonicalJson(body.identity) !== canonicalJson(identity) ||
        !(await verifyP256(identity.publicKey, canonicalJson(body), identityProof))
      )
        throw Error("Unverified environment");
      const features = body.features.filter(
        (f) => opts.timeline !== false || f !== "timelineItems",
      );
      const envelope = {
        protocolVersion: { major: body.protocolVersion.major, minor: opts.minor ?? 0 },
        environmentId: identity.id,
        connectionId: body.connectionId,
        challengeId: body.challengeId,
        challenge: body.challenge,
        signer,
      };
      const auth = {
        ...envelope,
        kind: "client.authenticate",
        method: "session.authenticate",
        clientNonce: nonce,
        features,
        sequence: ++seq,
      };
      secret = async (payload, id) => {
        const req = {
          ...envelope,
          method: "todo.submitSecret",
          payload,
          kind: "signedRequest",
          commandId: id,
          sequence: ++seq,
        };
        return v.parse(PrivateSecretRequestSchema, {
          ...req,
          signature: await device.device.sign(canonicalJson(req)),
        });
      };
      const r = new ThreadReplica(
        frame.message,
        {
          principal: device.principal,
          signer,
          features,
          protocolVersion: envelope.protocolVersion,
        },
        {
          utf8,
          now: () => performance.now(),
          write(w) {
            bytes += wireBytes(w, utf8);
            socket.send(w);
            return 1;
          },
        },
        {
          store:
            opts.store ??
            (opts.timing
              ? {
                  async transact(edit) {
                    const start = performance.now();
                    let apply = 0;
                    const result = await cache.transact((old) => {
                      const begin = performance.now();
                      const applied = edit(old);
                      apply = performance.now() - begin;
                      return applied;
                    });
                    opts.timing?.(apply, performance.now() - start - apply);
                    return result;
                  },
                }
              : cache),
          read: () => cache.read(),
          id: () => v.parse(SubscriptionIdSchema, crypto.randomUUID()),
          async sign(method, payload) {
            const request = {
              ...envelope,
              method,
              payload,
              kind: "signedRequest",
              commandId: opts.commandId?.(method) ?? crypto.randomUUID(),
              sequence: ++seq,
            };
            return v.parse(SignedRequestSchema, {
              ...request,
              signature: await device.device.sign(canonicalJson(request)),
            });
          },
          ...(opts.acknowledged ? { acknowledged: opts.acknowledged } : {}),
          installed(head) {
            heads.push(head);
            opts.installed?.(head);
          },
          ...(opts.pageStaged ? { pageStaged: opts.pageStaged } : {}),
          received(kind, message) {
            messages.push({ kind, message, at: arrival });
            opts.received?.(kind, message, arrival);
          },
        },
      );
      replica = r;
      r.ready.then(() => ready.resolve(r), fail);
      r.authenticate(
        frame,
        wireBytes(wire, utf8),
        v.parse(ClientAuthenticationSchema, {
          ...auth,
          signature: await device.device.sign(canonicalJson(auth)),
        }),
      );
    } catch (err) {
      fail(err);
    }
  };
  try {
    const client = await within(ready.promise, 5000, "Configured thread connection");
    return {
      client,
      submitSecret(payload: PrivateSecretRequest["payload"], id: CommandId) {
        if (!secret) throw Error("Private session unavailable");
        const sign = secret;
        return client.submitSecret(() => sign(payload, id));
      },
      principal: device.principal.id,
      heads,
      messages,
      cache,
      bytes: () => bytes,
      replyBytes: () => replyBytes,
      async at(position: string) {
        await until(() => heads.some((h) => h.through === position), "installed " + position);
        return heads.find((h) => h.through === position)!;
      },
      async close() {
        socket.terminate();
        await within(closed.promise, 4000, "Replica close");
      },
    };
  } catch (e) {
    socket.terminate();
    throw e;
  }
}
export async function until(done: () => boolean, label: string) {
  const end = performance.now() + 4500;
  while (!done()) {
    if (performance.now() > end) throw Error("Timeout waiting for " + label);
    await Bun.sleep(1);
  }
}
export async function threadFixture<T>(
  body: (f: Awaited<ReturnType<typeof setup>>) => Promise<T>,
  root = productRoot,
  onStage?: (name: string) => void,
) {
  return withState(async (dir) => {
    const f = await setup(dir, root, onStage);
    try {
      return await body(f);
    } finally {
      onStage?.("closing the fixture");
      await f.close();
    }
  });
}
async function setup(dir: string, root: string, onStage?: (name: string) => void) {
  onStage?.("pairing devices");
  const pairing = await startPairedProject({
    stateDir: dir,
    projectId: "project-notes",
    requests: [["thread.view", "thread.send", "thread.reply", "owner.decide", "term.input"]],
  });
  const stateDir = join(pairing.stateDir, "host");
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  const f = await startFirstSendFixture({
    stateDir,
    projectDirectory: join(dir, "work"),
    adapter: "replay",
    root,
    point: "resume",
    ...(onStage && { onStage }),
    ipc(message) {
      const reply = v.parse(v.object({ id: v.string(), error: v.nullable(v.string()) }), message);
      const waiter = pending.get(reply.id);
      if (reply.error === null) waiter?.resolve();
      else waiter?.reject(Error(reply.error));
    },
  }).catch(async (e) => {
    await pairing.close();
    throw e;
  });
  const tablet = pairing.clients[0];
  if (!tablet) throw Error("Missing paired device");
  const caches = new Map<string, SqliteThreadCache>();
  const live = new Set<Awaited<ReturnType<typeof connectReplica>>>();
  let exit: Error | undefined;
  void f.child.exited.then((code) => {
    exit = Error(`Seed writer exited (${f.child.signalCode ?? code})`);
    for (const waiter of pending.values()) waiter.reject(exit);
  });
  async function control(command: object) {
    if (exit) throw exit;
    const id = crypto.randomUUID();
    const waiter = Promise.withResolvers<void>();
    pending.set(id, waiter);
    try {
      f.child.send({ id, command });
      await waiter.promise;
    } finally {
      pending.delete(id);
    }
  }
  const threadId = v.parse(ThreadIdSchema, "thread-notes");
  return {
    f,
    pairing,
    dir,
    stateDir,
    threadId,
    control,
    async seed(rows: unknown[]) {
      await control({ rows });
    },
    async start() {
      await control({
        rows: [
          {
            objectType: "thread",
            value: {
              id: threadId,
              projectId: pairing.projectId,
              worktreeId: null,
              title: "Draft notes",
              lineage: { kind: "root" },
              version: "1",
            },
          },
        ],
      });
    },
    async connect(name: string, opts: Options = {}) {
      const device = name === "tablet" ? tablet : pairing.owner;
      let cache = caches.get(name);
      if (!cache) {
        cache = new SqliteThreadCache(
          join(dir, name + ".sqlite"),
          canonicalJson([
            pairing.identity.id,
            device.principal.id,
            opts.timeline !== false,
            opts.minor ?? 0,
          ]),
        );
        caches.set(name, cache);
      }
      const r = await connectReplica(f.endpoint, pairing.identity, device, cache, opts);
      live.add(r);
      return r;
    },
    async close() {
      try {
        await Promise.all([...live].map((r) => r.close()));
        for (const c of caches.values()) c.close();
      } finally {
        try {
          await f.close();
        } finally {
          await pairing.close();
        }
      }
    },
  };
}
export function turnRows(threadId: string, i: number) {
  const roundId = "round-" + i,
    messageId = "message-" + i;
  return [
    {
      objectType: "message",
      value: {
        threadId,
        id: messageId,
        roundId,
        author: { kind: "person", id: "person-lee" },
        text: "Message " + i,
        references: [],
        attachments: [],
        version: "1",
      },
    },
    {
      objectType: "round",
      value: {
        threadId,
        id: roundId,
        messageId,
        place: String(i),
        attempt: {
          attemptId: "attempt-" + i,
          deliveryId: "delivery-" + i,
          phase: { kind: "notDelivered", reason: "stopped", lateReceipt: null },
        },
        version: "1",
      },
    },
  ];
}
