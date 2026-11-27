import { join } from "node:path";
import * as v from "valibot";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { runReplayTurn } from "@kraka/environment";
import {
  SubscriptionIdSchema,
  type ProjectId,
  CommandIdSchema,
  DeviceKeyIdSchema,
  DeviceIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  P256PublicKeySchema,
} from "@kraka/protocol";
import { openAccessHost } from "../../packages/daemon/src/access";
import { listenIdentity } from "../../packages/daemon/src/identity";
import { fixture, sampleRequest } from "./replay-process";

const stateDir = process.argv[2] ?? "";
if (!stateDir || !process.send) throw Error("Expected private fixture channel");
const emit = (message: unknown) => process.send?.(message);
let instant = Date.now(),
  present = true,
  acknowledged = true;
const host = await openAccessHost(
  join(stateDir, "host"),
  {
    present: async () => {
      emit({ event: "hostPresent" });
      return acknowledged;
    },
    approve: async (detail) => {
      emit({ event: "presence", detail, allowed: present });
      return present;
    },
  },
  () => instant,
);
const gate = Promise.withResolvers<void>();
let lose = false;
const listener = listenIdentity(
  {
    ...host.port,
    observed(detail) {
      emit({ event: "observed", ...detail });
    },
    async beforePairingReply(result) {
      if (lose && result.kind === "pairing.completed") {
        emit({ event: "lostReply" });
        await gate.promise;
      }
    },
  },
  0,
  ["https://EXAMPLE.test:443/"],
);
const executorGate = Promise.withResolvers<void>();
let running: Promise<void> | null = null;
let project: ProjectId | null = null;
const control = v.variant("op", [
  v.object({ op: v.literal("project"), projectId: ProjectIdSchema, threadId: ThreadIdSchema }),
  v.object({
    op: v.literal("owner"),
    deviceId: DeviceIdSchema,
    keyId: DeviceKeyIdSchema,
    publicKey: P256PublicKeySchema,
  }),
  v.object({
    op: v.literal("upgrade"),
    deviceId: DeviceIdSchema,
    keyId: DeviceKeyIdSchema,
    commandId: CommandIdSchema,
  }),
  v.object({ op: v.literal("presence"), allowed: v.boolean() }),
  v.object({
    op: v.literal("publish"),
    threadId: ThreadIdSchema,
    subscriptionId: SubscriptionIdSchema,
  }),
  v.object({ op: v.literal("atHost"), allowed: v.boolean() }),
  v.object({ op: v.literal("advance"), ms: v.number() }),
  ...(["stop", "lose", "executor", "finish"] as const).map((op) => v.object({ op: v.literal(op) })),
]);
async function act(raw: unknown) {
  const msg = v.parse(control, raw);
  switch (msg.op) {
    case "project":
      project = msg.projectId;
      host.store.provisionProject(msg.projectId);
      host.store.provisionThread(msg.threadId, msg.projectId);
      return true;
    case "owner": {
      const state = await host.trusted.confirm({
        ...msg,
        environment: host.identity,
        kind: "bootstrap",
      });
      return state === "denied" ? null : host.store.device(msg.deviceId);
    }
    case "upgrade":
      return host.trusted.grantOwnerUpgrade({ ...msg, environmentId: host.identity.id });
    case "presence":
      present = msg.allowed;
      return true;
    case "publish":
      listener.publish(msg.threadId, {
        kind: "subscription.reset",
        subscriptionId: msg.subscriptionId,
        reason: "rangeChanged",
      });
      return true;
    case "atHost":
      acknowledged = msg.allowed;
      return true;
    case "advance":
      instant += msg.ms;
      return true;
    case "lose":
      lose = true;
      return true;
    case "executor": {
      const recording = parseReplayRecording(await Bun.file(fixture).text());
      const adapter = createReplayAdapter(recording);
      const original = adapter.events.bind(adapter);
      adapter.events = async function* (session, filter) {
        for await (const event of original(session, filter)) {
          emit({ event: "executorActive" });
          await executorGate.promise;
          yield event;
        }
      };
      running = runReplayTurn({
        request: sampleRequest,
        adapter,
        expectedText: recording.expectedText,
        modelId: recording.modelId,
        workingDirectory: stateDir,
        signal: new AbortController().signal,
        emit(message) {
          if (project && message.kind === "accepted" && message.result.kind === "threadStarted") {
            host.store.provisionThread(message.result.threadId, project);
            emit({ event: "executorThread", threadId: message.result.threadId });
          }
          emit({ event: "executorUpdate", message });
        },
      });
      void running.catch((e) => emit({ event: "executorError", message: String(e) }));
      return true;
    }
    case "finish":
      executorGate.resolve();
      await running;
      return true;
    case "stop": {
      // Stop peers before releasing the deliberately held reply.
      const closing = listener.close();
      gate.resolve();
      executorGate.resolve();
      await closing;
      await running;
      host.close();
      return true;
    }
  }
}
process.on("message", async (message: unknown) => {
  const envelope = v.parse(v.object({ id: v.string(), op: v.string() }), message);
  try {
    emit({ response: envelope.id, value: await act(message) });
  } catch (e) {
    emit({ response: envelope.id, error: String(e) });
  }
  if (envelope.op === "stop") process.disconnect?.();
});
emit({ event: "ready", identity: host.identity, origin: listener.origin });
