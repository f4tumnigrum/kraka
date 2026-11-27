import { SubscriptionPageSchema, type SubscriptionPage } from "@kraka/protocol";
import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type InstancePublication, InstancePublicationSchema } from "@kraka/environment";
import {
  CommandIdSchema,
  type CommandReceipt,
  CommandReceiptSchema,
  ConnectionChallengeSchema,
  canonicalJson,
  type HistoryPage,
  HistoryPageSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import { within } from "./replay-process";

export const fixtureSigner = {
  kind: "device",
  deviceId: "first-send-local-device",
  keyId: "first-send-local-key",
} as const;
export const fixtureActor = "first-send-local-owner";
const helloSchema = v.strictObject({
  environmentId: v.string(),
  instanceId: v.string(),
  connectionId: v.string(),
  challengeId: v.string(),
  challenge: ConnectionChallengeSchema,
});
export async function connectFirstSend(stateDir: string, instance: InstancePublication) {
  const key = createPrivateKey(readFileSync(join(stateDir, "fixture-private.pem")));
  const socket = new WebSocket(instance.endpoint);
  const ready = Promise.withResolvers<v.InferOutput<typeof helloSchema>>();
  let hello: v.InferOutput<typeof helloSchema> | undefined;
  let sequence = 0;
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<CommandReceipt>>>();
  const pages = new Map<string, ReturnType<typeof Promise.withResolvers<HistoryPage>>>();
  const snapshots = new Map<string, ReturnType<typeof Promise.withResolvers<SubscriptionPage>>>();
  function fail(reason: Error) {
    ready.reject(reason);
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
    for (const waiter of pages.values()) waiter.reject(reason);
    pages.clear();
    for (const waiter of snapshots.values()) waiter.reject(reason);
    snapshots.clear();
  }
  socket.onerror = () => fail(new Error("Writer connection failed"));
  socket.onclose = () => fail(new Error("Writer connection closed"));
  socket.onmessage = ({ data }) => {
    try {
      if (!hello) {
        hello = v.parse(helloSchema, JSON.parse(String(data)));
        if (
          hello.instanceId !== instance.instanceId ||
          hello.environmentId !== instance.environmentId
        )
          throw new Error("Foreign writer hello");
        ready.resolve(hello);
        return;
      }
      const raw = JSON.parse(String(data));
      if (raw.kind === "subscription.page") {
        const page = v.parse(SubscriptionPageSchema, raw);
        const waiter = snapshots.get(page.subscriptionId);
        if (!waiter) throw Error("Unexpected subscription page");
        waiter.resolve(page);
        return;
      }
      if (["subscription.begin", "subscription.seal", "subscription.ended"].includes(raw.kind))
        return;
      if (raw.kind === "history.page") {
        const page = v.parse(HistoryPageSchema, raw);
        const waiter = pages.get(page.threadId);
        if (!waiter) throw Error("Unexpected history page");
        waiter.resolve(page);
        return;
      }
      const receipt = v.parse(CommandReceiptSchema, raw);
      const waiter = pending.get(receipt.commandId);
      if (!waiter) throw new Error("Unmatched receipt");
      pending.delete(receipt.commandId);
      waiter.resolve(receipt);
    } catch (error) {
      fail(Error(String(error)));
      socket.terminate();
    }
  };
  try {
    await within(ready.promise, 10000, "Writer hello");
  } catch (e) {
    socket.terminate();
    throw e;
  }
  return {
    close() {
      socket.terminate();
    },
    async subscribedRounds(threadId: string) {
      const subscriptionId = crypto.randomUUID(),
        waiter = Promise.withResolvers<SubscriptionPage>();
      snapshots.set(subscriptionId, waiter);
      void waiter.promise.catch(() => {});
      try {
        const { receipt } = await this.send(
          "subscription.openThread",
          { subscriptionId, streamId: 2, threadId, knownWindow: [], after: null, recheckTodos: [] },
          crypto.randomUUID(),
          1,
        );
        if (receipt.kind !== "accepted") throw Error("Input subscription rejected");
        const page = await within(waiter.promise, 5000, "Input subscription");
        await this.send("subscription.close", { subscriptionId });
        return page.changes.flatMap((change) =>
          change.kind === "object.replace" && change.object.objectType === "round"
            ? [change.object.value]
            : [],
        );
      } finally {
        snapshots.delete(subscriptionId);
      }
    },
    async readInputHistory(threadId: string, roundId?: string) {
      if (pages.has(threadId)) throw Error("History read outstanding");
      const waiter = Promise.withResolvers<HistoryPage>();
      pages.set(threadId, waiter);
      void waiter.promise.catch(() => {});
      try {
        const { receipt } = await this.send(
          "thread.readHistory",
          { threadId, anchor: null, streamId: 1 },
          crypto.randomUUID(),
          1,
        );
        if (receipt.kind !== "accepted") throw Error(JSON.stringify(receipt));
        const page = await within(waiter.promise, 5000, "Input history");
        return {
          version: page.verifiedAt.through,
          rounds: page.rows.flatMap((r) =>
            r.objectType === "round" && (!roundId || r.value.id === roundId) ? [r.value] : [],
          ),
          messages: page.rows.flatMap((r) =>
            r.objectType === "message" && (!roundId || r.value.roundId === roundId)
              ? [r.value]
              : [],
          ),
        };
      } finally {
        pages.delete(threadId);
      }
    },
    async send(method: string, payload: unknown, id: string = crypto.randomUUID(), minor = 0) {
      if (!hello) throw new Error("Missing writer hello");
      const commandId = v.parse(CommandIdSchema, id);
      const body = {
        kind: "signedRequest",
        protocolVersion: { major: 1, minor },
        environmentId: instance.environmentId,
        connectionId: hello.connectionId,
        challengeId: hello.challengeId,
        challenge: hello.challenge,
        signer: fixtureSigner,
        sequence: ++sequence,
        commandId,
        method,
        payload,
      };
      const request = {
        ...body,
        signature: sign("sha256", Buffer.from(canonicalJson(body)), {
          key,
          dsaEncoding: "ieee-p1363",
        }).toString("base64url"),
      };
      const waiter = Promise.withResolvers<CommandReceipt>();
      if (pending.has(commandId)) throw new Error("Command already outstanding");
      pending.set(commandId, waiter);
      try {
        socket.send(JSON.stringify(request));
        return { request, receipt: await within(waiter.promise, 10000, "Command receipt") };
      } finally {
        pending.delete(commandId);
      }
    },
  };
}
if (import.meta.main) {
  const options = v.parse(
    v.object({
      stateDir: v.string(),
      instance: InstancePublicationSchema,
      method: v.string(),
      payload: v.unknown(),
      id: v.string(),
    }),
    await Bun.stdin.json(),
  );
  const client = await connectFirstSend(options.stateDir, options.instance);
  try {
    console.log(JSON.stringify(await client.send(options.method, options.payload, options.id)));
  } finally {
    client.close();
  }
}
