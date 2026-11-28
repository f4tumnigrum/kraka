import { join } from "node:path";
import * as v from "valibot";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { runReplayTurn } from "@kraka/environment";
import {
  EnvironmentIdSchema,
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
import { browserAssets, preflight } from "../../packages/daemon/src/browser-listener";
import { listenIdentity, type IdentityPort } from "../../packages/daemon/src/identity";
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
const options = process.argv[3] ? JSON.parse(process.argv[3]) : null;
const browser = options
  ? {
      binding: await preflight(options),
      asset: await browserAssets(),
      fixturePage:
        '<!doctype html><main></main><script type="module">import {startBrowserPage} from "/assets/browser-host.js";startBrowserPage(document.querySelector("main"))</script>',
    }
  : undefined;
let configurationGate: ReturnType<typeof Promise.withResolvers<void>> | undefined;
const originalIdentity = host.identity;
const silent = Promise.withResolvers<void>();
let alternate: "changed" | "foreign" | "silent" | null = null;
const alt = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
  "sign",
  "verify",
]);
const alternativeKey = Buffer.from(await crypto.subtle.exportKey("raw", alt.publicKey)).toString(
  "base64url",
);
const outbox = options?.outbox
  ? await (await import("./outbox-peer")).outboxPeer(
      join(stateDir, "host"),
      host,
      options.outbox,
      emit,
    )
  : null;
const peerPort = {
  ...(outbox ? { openThread: outbox.openThread } : {}),
  ...host.port,
  get identity() {
    if (!alternate || alternate === "silent") return originalIdentity;
    return {
      ...originalIdentity,
      id:
        alternate === "changed"
          ? originalIdentity.id
          : v.parse(EnvironmentIdSchema, "other-environment"),
      publicKey: alternativeKey,
    };
  },
  async sign(canonical: string) {
    if (alternate === "silent") await silent.promise;
    return alternate === "changed" || alternate === "foreign"
      ? Buffer.from(
          await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            alt.privateKey,
            new TextEncoder().encode(canonical),
          ),
        ).toString("base64url")
      : host.port.sign(canonical);
  },
  observed(detail) {
    emit({ event: "observed", at: performance.now(), ...detail });
  },
  async beforeConfiguration(session) {
    if (configurationGate) {
      emit({
        event: "configurationHeld",
        deviceId: session.principal.kind === "device" ? session.principal.deviceId : null,
      });
      await configurationGate.promise;
    }
  },
  async beforePairingReply(result) {
    if (lose && result.kind === "pairing.completed") {
      emit({ event: "lostReply" });
      await gate.promise;
    }
  },
} satisfies IdentityPort;
const listener = listenIdentity(
  peerPort,
  browser?.binding.port ?? 0,
  ["https://EXAMPLE.test:443/"],
  undefined,
  browser,
);
const executorGate = Promise.withResolvers<void>();
let running: Promise<void> | null = null;
let project: ProjectId | null = null;
const control = v.variant("op", [
  v.object({ op: v.literal("outboxStatus") }),
  v.object({ op: v.literal("outboxRelease") }),
  v.object({ op: v.literal("outboxNetwork"), enabled: v.boolean() }),
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
  v.object({ op: v.literal("deviceCount"), deviceId: DeviceIdSchema }),
  v.object({ op: v.literal("peer"), mode: v.picklist(["changed", "foreign", "silent"]) }),
  ...(
    [
      "stop",
      "lose",
      "executor",
      "finish",
      "holdConfiguration",
      "releaseConfiguration",
      "resumeReply",
    ] as const
  ).map((op) => v.object({ op: v.literal(op) })),
]);
async function act(raw: unknown) {
  const msg = v.parse(control, raw);
  switch (msg.op) {
    case "outboxRelease":
      outbox?.release();
      return true;
    case "outboxStatus":
      return outbox?.status();
    case "outboxNetwork":
      outbox?.network(msg.enabled);
      return true;
    case "deviceCount":
      return host.store.db
        .query("SELECT count(*) AS count FROM devices WHERE device=?")
        .get(msg.deviceId);
    case "peer":
      alternate = msg.mode;
      return true;
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
    case "holdConfiguration":
      configurationGate = Promise.withResolvers<void>();
      return true;
    case "releaseConfiguration":
      configurationGate?.resolve();
      configurationGate = undefined;
      return true;
    case "resumeReply":
      gate.resolve();
      lose = false;
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
      silent.resolve();
      gate.resolve();
      configurationGate?.resolve();
      executorGate.resolve();
      await closing;
      await running;
      await outbox?.close();
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
