import * as v from "valibot";
import type { AdapterEventEnvelope, QueueRow, DeliveryRecovery } from "@kraka/environment";
import {
  AttemptIdSchema,
  CheckpointCaptureSchema,
  ConnectionIdSchema,
  ControlMessageSchema,
  DataMessageSchema,
  DeliveryIdSchema,
  DeviceIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  FlowWindowSchema,
  isValidFlowWindow,
  NativeItemIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  PrincipalIdSchema,
  RoundIdSchema,
  RoundEndTimeEvidenceSchema,
  SignedRequestSchema,
  SubscriptionIdSchema,
  SyncCursorSchema,
  SyncPositionSchema,
  SynchronizedObjectSchema,
  TerminalAddressSchema,
  TerminalOffsetSchema,
  TerminalSessionSchema,
  ThreadIdSchema,
} from "@kraka/protocol";
import { assertFakeCredentials } from "./credentials";

const text = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const nonempty = <S extends v.GenericSchema>(schema: S) => v.pipe(v.array(schema), v.minLength(1));
const ticket = { attemptId: AttemptIdSchema, deliveryId: DeliveryIdSchema };
const deliveryAndStart = [
  v.strictObject({ kind: v.literal("deliveryWritten"), ...ticket, at: count }),
  v.strictObject({
    kind: v.literal("deliveryReceived"),
    ...ticket,
    receipt: v.strictObject({
      kind: v.literal("input"),
      sessionId: NativeSessionIdSchema,
      itemId: NativeItemIdSchema,
    }),
  }),
  v.strictObject({
    kind: v.literal("roundStarted"),
    attemptId: AttemptIdSchema,
    nativeRootTurnId: NativeRootTurnIdSchema,
    at: count,
  }),
] as const;
const terminalFact = v.strictObject({
  kind: v.literal("roundEnded"),
  attemptId: AttemptIdSchema,
  outcome: v.strictObject({
    reason: v.literal("completed"),
    nativeReason: v.nullable(v.string()),
  }),
});
/** The fixture boundary validates the subset of the adapter contract used by these examples. */
export const ReplayFactSchema = v.strictObject({
  family: v.literal("replay"),
  instanceId: ExecutorInstanceIdSchema,
  sessionId: NativeSessionIdSchema,
  epoch: count,
  eventId: text,
  payload: v.variant("kind", [
    ...deliveryAndStart,
    v.strictObject({
      ...terminalFact.entries,
      nativeRootTurnId: NativeRootTurnIdSchema,
      endedAt: count,
      endTimeEvidence: v.optional(RoundEndTimeEvidenceSchema, {
        source: "unknown",
        executorEndedAt: null,
        environmentObservedAt: null,
      }),
    }),
  ]),
}) satisfies v.GenericSchema<unknown, AdapterEventEnvelope<"replay">>;

// Earlier recordings can be inspected without attributing their events to an invented instance or root.
const legacyFact = v.strictObject({
  ...v.omit(ReplayFactSchema, ["instanceId"]).entries,
  payload: v.variant("kind", [...deliveryAndStart, terminalFact]),
});

const queueSource = v.strictObject({
  roundId: RoundIdSchema,
  source: v.picklist(["person", "automation"]),
  recovery: v.picklist(["none", "query", "deduplicate"]),
}) satisfies v.GenericSchema<
  unknown,
  { roundId: QueueRow["id"]; source: QueueRow["source"]; recovery: DeliveryRecovery }
>;
const environment = v.strictObject({
  environmentId: EnvironmentIdSchema,
  through: SyncPositionSchema,
  objects: v.array(SynchronizedObjectSchema),
  queue: v.optional(v.array(queueSource)),
  terminals: v.optional(v.array(TerminalSessionSchema)),
  legacySettingFields: v.optional(v.array(text)),
});
const windowSchema = v.pipe(
  FlowWindowSchema,
  v.check(isValidFlowWindow, "Consumed bytes exceed the stream limit"),
);
const stream = {
  subscriptionId: SubscriptionIdSchema,
  streamId: positive,
  flow: v.variant("kind", [
    v.strictObject({ kind: v.literal("draining") }),
    v.strictObject({ kind: v.literal("manual"), sentBytes: count, window: windowSchema }),
  ]),
};
const subscriptions = v.array(
  v.variant("kind", [
    v.strictObject({ kind: v.literal("objects"), ...stream, installed: SyncCursorSchema }),
    v.strictObject({
      kind: v.literal("terminal"),
      ...stream,
      address: TerminalAddressSchema,
      sentThrough: TerminalOffsetSchema,
    }),
  ]),
);
const connection = v.strictObject({
  environmentId: EnvironmentIdSchema,
  connectionId: ConnectionIdSchema,
  subscriptions,
});
const endpoint = { deviceId: DeviceIdSchema, environmentId: EnvironmentIdSchema };
function scenarioEvents<S extends v.GenericSchema>(fact: S) {
  return v.variant("kind", [
    v.strictObject({
      kind: v.literal("commands"),
      deviceId: DeviceIdSchema,
      requests: nonempty(SignedRequestSchema),
    }),
    v.strictObject({
      kind: v.literal("executor"),
      environmentId: EnvironmentIdSchema,
      threadId: ThreadIdSchema,
      fact,
    }),
    v.strictObject({ kind: v.literal("disconnect"), ...endpoint }),
    v.strictObject({ kind: v.literal("connect"), ...endpoint, connectionId: ConnectionIdSchema }),
    v.strictObject({ kind: v.literal("restart"), environmentId: EnvironmentIdSchema }),
    v.strictObject({ kind: v.literal("advanceTime"), milliseconds: positive }),
    v.strictObject({
      kind: v.literal("claimInput"),
      environmentId: EnvironmentIdSchema,
      threadId: ThreadIdSchema,
      attemptId: AttemptIdSchema,
    }),
    v.strictObject({
      kind: v.literal("checkpointSettled"),
      environmentId: EnvironmentIdSchema,
      capture: CheckpointCaptureSchema,
    }),
    v.strictObject({ kind: v.literal("window"), ...endpoint, update: windowSchema }),
    v.strictObject({
      kind: v.literal("terminalOutput"),
      environmentId: EnvironmentIdSchema,
      address: TerminalAddressSchema,
      utf8: text,
      repetitions: positive,
    }),
  ]);
}
export const ScenarioEventSchema = scenarioEvents(ReplayFactSchema);
const toClient = v.pipe(
  ControlMessageSchema,
  v.check(
    (message) =>
      message.kind !== "signedRequest" &&
      message.kind !== "client.authenticate" &&
      message.kind !== "pairing.request" &&
      message.kind !== "pairing.exchange",
    "Expected an environment-to-client message",
  ),
);
export const ScenarioMessageSchema = v.union([toClient, DataMessageSchema, windowSchema]);
const delivery = v.strictObject({
  after: text,
  environmentId: EnvironmentIdSchema,
  messages: nonempty(ScenarioMessageSchema),
});
const client = v.strictObject({
  deviceId: DeviceIdSchema,
  principalId: PrincipalIdSchema,
  connections: nonempty(connection),
  expected: v.array(delivery),
});
const scenarioFields = {
  name: text,
  description: text,
  startTime: count,
  environments: nonempty(environment),
  clients: v.pipe(v.array(client), v.minLength(2)),
};
const inputs = <S extends v.GenericSchema>(event: S) =>
  nonempty(v.strictObject({ label: text, event }));
export const ScenarioSchema = v.variant("format", [
  v.strictObject({
    ...scenarioFields,
    format: v.literal("kraka-scenario-v1"),
    inputs: inputs(scenarioEvents(legacyFact)),
  }),
  v.strictObject({
    ...scenarioFields,
    format: v.literal("kraka-scenario-v2"),
    inputs: inputs(ScenarioEventSchema),
  }),
]);
export type ReplayScenario = v.InferOutput<typeof ScenarioSchema>;
export type ScenarioEvent = v.InferOutput<typeof ScenarioEventSchema>;
export type ScenarioMessage = v.InferOutput<typeof ScenarioMessageSchema>;

function unique<T>(ids: readonly T[], field: string) {
  const result = new Set(ids);
  if (result.size !== ids.length) throw new Error(`Duplicate ${field}`);
  return result;
}
/** Check addresses and observation labels without executing a scenario or computing any expected message. */
export function parseScenario(raw: unknown): ReplayScenario {
  assertFakeCredentials(raw);
  const s = v.parse(ScenarioSchema, raw);
  if (s.format === "kraka-scenario-v2") {
    for (const env of s.environments) {
      for (const object of env.objects) {
        if (object.objectType !== "round") continue;
        const phase = object.value.attempt.phase;
        if (phase.kind === "closing" || phase.kind === "finished" || phase.kind === "endedEarly") {
          phase.endTimeEvidence ??= {
            source: "unknown",
            executorEndedAt: null,
            environmentObservedAt: null,
          };
        }
      }
    }
  }
  const envs = unique(
    s.environments.map((e) => e.environmentId),
    "environment",
  );
  unique(
    s.clients.map((c) => c.deviceId),
    "client",
  );
  unique(
    s.inputs.map((i) => i.label),
    "input label",
  );
  const positions = new Map(s.inputs.map((input, i) => [input.label, i]));
  const routes = new Map(
    s.clients.map((c) => [
      c.deviceId,
      unique(
        c.connections.map((link) => link.environmentId),
        "client endpoint",
      ),
    ]),
  );
  for (const { event } of s.inputs) {
    if (event.kind === "commands") {
      for (const request of event.requests) {
        if (!routes.get(event.deviceId)?.has(request.environmentId))
          throw new Error("Unknown command endpoint");
        if (request.signer.kind !== "device" || request.signer.deviceId !== event.deviceId)
          throw new Error("Invalid command signer");
      }
    } else if ("environmentId" in event) {
      if (!envs.has(event.environmentId)) throw new Error("Unknown input environment");
      if ("deviceId" in event && !routes.get(event.deviceId)?.has(event.environmentId))
        throw new Error("Unknown client endpoint");
    }
  }
  for (const c of s.clients) {
    for (const link of c.connections) {
      if (!envs.has(link.environmentId)) throw new Error("Unknown client environment");
      unique(
        link.subscriptions.map((sub) => sub.subscriptionId),
        "subscription",
      );
      unique(
        link.subscriptions.map((sub) => sub.streamId),
        "stream",
      );
      for (const sub of link.subscriptions) {
        if (sub.kind === "objects" && sub.installed.environmentId !== link.environmentId)
          throw new Error("Foreign subscription cursor");
        if (
          sub.flow.kind === "manual" &&
          (sub.flow.window.epoch !== link.connectionId ||
            sub.flow.window.streamId !== sub.streamId ||
            sub.flow.window.consumedBytes > sub.flow.sentBytes ||
            sub.flow.sentBytes > sub.flow.window.limitBytes)
        )
          throw new Error("Invalid initial stream window");
      }
    }
    let last = -1;
    for (const group of c.expected) {
      const at = positions.get(group.after);
      if (!routes.get(c.deviceId)?.has(group.environmentId) || at === undefined || at < last)
        throw new Error("Invalid expected delivery address or order");
      last = at;
    }
  }
  return s;
}
