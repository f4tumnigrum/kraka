import { createPrivateKey, sign } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  canonicalJson,
  CommandReceiptSchema,
  ExecutorTurnUpdateSchema,
  type ExecutorTurnUpdate,
  CommandIdSchema,
  ConnectionChallengeSchema,
  type CommandReceipt,
} from "@kraka/protocol";
import { InstancePublicationSchema, type InstancePublication } from "@kraka/environment";
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
export async function connectFirstSend(
  stateDir: string,
  instance: InstancePublication,
  onUpdate?: (event: ExecutorTurnUpdate) => void,
) {
  const key = createPrivateKey(readFileSync(join(stateDir, "fixture-private.pem")));
  const socket = new WebSocket(instance.endpoint);
  const ready = Promise.withResolvers<v.InferOutput<typeof helloSchema>>();
  let hello: v.InferOutput<typeof helloSchema> | undefined;
  let sequence = 0;
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<CommandReceipt>>>();
  function fail(reason: Error) {
    ready.reject(reason);
    for (const request of pending.values()) request.reject(reason);
    pending.clear();
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
      if (onUpdate && raw.kind !== "accepted" && raw.kind !== "rejected") {
        onUpdate(v.parse(ExecutorTurnUpdateSchema, raw));
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
    async send(method: string, payload: unknown, id: string = crypto.randomUUID()) {
      if (!hello) throw new Error("Missing writer hello");
      const commandId = v.parse(CommandIdSchema, id);
      const body = {
        kind: "signedRequest",
        protocolVersion: { major: 1, minor: 0 },
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
