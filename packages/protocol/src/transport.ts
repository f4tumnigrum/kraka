import { AppNoteReadSchema } from "./executor-tools";
import { TextReturnedEventSchema } from "./handoffs";
import { ContextOperationChangeSchema } from "./context-operations";
import {
  ExecutorSessionObservationSchema,
  ToolActivityHistoryItemSchema,
  TimelineItemSchema,
} from "./timeline";
import { ChildResultTransferSchema } from "./executor-tools";
import { ThreadSummarySchema, ListCountsSchema } from "./thread-list";
import { GitStatusSchema } from "./workspace";
import { ForgeProgressSchema, ForgeHistorySchema } from "./forge";
import { RollbackProgressSchema } from "./checkpoints";
import {
  TerminalSnapshotSchema,
  TerminalOutputSchema,
  TerminalGapSchema,
  TerminalSessionSchema,
} from "./terminal";
import { WorktreeViewSchema } from "./worktrees";
import * as v from "valibot";
import { ListValueChangeSchema } from "./list-wire";
import { AttentionFactsSchema } from "./attention";
import {
  ConnectionChallengeIdSchema,
  ConnectionIdSchema,
  ContentTransferIdSchema,
  HistoryAnchorIdSchema,
  ObjectVersionSchema,
  SubscriptionIdSchema,
  SyncCursorSchema,
  SyncPassIdSchema,
  ThreadIdSchema,
  TodoRequestIdSchema,
} from "./ids";
import {
  CheckpointCaptureSchema,
  ObjectKeySchema,
  EnvironmentSchema,
  MessageSchema,
  ProjectSchema,
  RoundSchema,
  ThreadSchema,
  TodoRequestSchema,
  WorktreeSchema,
} from "./objects";
import {
  ClientAuthenticationSchema,
  CommandReceiptSchema,
  ConnectionChallengeSchema,
  DevicePairingResultSchema,
  PairingChallengeSchema,
  PairingExchangeSchema,
  PairingPendingSchema,
  PairingRequestSchema,
  ProtocolFeatureSetSchema,
  ProtocolVersionSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  SessionRejectedSchema,
  SignedRequestSchema,
} from "./requests";
import { P256SignatureSchema } from "./access";
import { EnvironmentIdentitySchema } from "./routes";
import { TRANSPORT_LIMITS, TransportLimitsSchema } from "./transport-limits";

const safeCounter = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const pageIndex = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_535));
const pageCount = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65_536));
const dataStreamId = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647));
const anyStreamId = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(2_147_483_647));
export const MAX_FRAME_PAYLOAD_BYTES = TRANSPORT_LIMITS.maxDataChunkBytes;

/** The client compares identity.id with the locally stored environment identity before authenticating. */
export const ServerHelloSchema = v.pipe(
  v.strictObject({
    kind: v.literal("server.hello"),
    connectionId: ConnectionIdSchema,
    challengeId: ConnectionChallengeIdSchema,
    challenge: ConnectionChallengeSchema,
    clientNonce: ConnectionChallengeSchema,
    protocolVersion: ProtocolVersionSchema,
    features: ProtocolFeatureSetSchema,
    identity: EnvironmentIdentitySchema,
    identityProof: P256SignatureSchema,
  }),
  v.description(
    "The client supplies a fresh public nonce in the WebSocket upgrade query (nonce). Verify the signed echo with the pinned environment key before sending a proof. Sign the canonical JSON of all hello fields except identityProof.",
  ),
);
export type ServerHello = v.InferOutput<typeof ServerHelloSchema>;

/** Expected principal and signer come from the local registration. The version and feature set are negotiated on this connection. */
export type AuthorizationExpectation = Pick<
  v.InferOutput<typeof SessionAuthorizedSchema>,
  "principal" | "signer" | "protocolVersion" | "features"
>;
export function matchesAuthorization(
  hello: ServerHello,
  authorized: v.InferOutput<typeof SessionAuthorizedSchema>,
  expected: AuthorizationExpectation,
): boolean {
  const { principal, signer, protocolVersion, features } = authorized;
  const identityMatches =
    principal.kind === "device" &&
    expected.principal.kind === "device" &&
    signer.kind === "device" &&
    expected.signer.kind === "device"
      ? principal.deviceId === signer.deviceId &&
        principal.deviceId === expected.principal.deviceId &&
        principal.ownerId === expected.principal.ownerId &&
        signer.deviceId === expected.signer.deviceId
      : principal.kind === "executor" &&
        expected.principal.kind === "executor" &&
        signer.kind === "executor" &&
        expected.signer.kind === "executor" &&
        signer.principalId === principal.id &&
        signer.principalId === expected.signer.principalId &&
        principal.executorInstanceId === expected.principal.executorInstanceId &&
        principal.threadId === expected.principal.threadId &&
        principal.attemptId === expected.principal.attemptId;
  const selected = new Set(expected.features);
  return (
    hello.connectionId === authorized.connectionId &&
    hello.identity.id === authorized.environmentId &&
    identityMatches &&
    principal.id === expected.principal.id &&
    signer.keyId === expected.signer.keyId &&
    protocolVersion.major === expected.protocolVersion.major &&
    protocolVersion.minor === expected.protocolVersion.minor &&
    protocolVersion.major === hello.protocolVersion.major &&
    protocolVersion.minor <= hello.protocolVersion.minor &&
    features.length === selected.size &&
    new Set(features).size === features.length &&
    features.every((feature) => selected.has(feature) && hello.features.includes(feature))
  );
}
export function matchesAuthorizedConfiguration(
  hello: ServerHello,
  authorized: v.InferOutput<typeof SessionAuthorizedSchema>,
  configuration: v.InferOutput<typeof SessionConfigurationSchema>,
  expected: AuthorizationExpectation,
): boolean {
  return (
    matchesAuthorization(hello, authorized, expected) &&
    authorized.connectionId === configuration.connectionId &&
    authorized.environmentId === configuration.environment.id &&
    authorized.environmentSessionId === configuration.environmentSessionId
  );
}

export const ControlMessageSchema = v.union([
  TerminalGapSchema,
  v.strictObject({
    kind: v.literal("terminal.state"),
    subscriptionId: SubscriptionIdSchema,
    session: TerminalSessionSchema,
  }),
  ServerHelloSchema,
  ClientAuthenticationSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  SessionRejectedSchema,
  PairingRequestSchema,
  PairingPendingSchema,
  PairingChallengeSchema,
  PairingExchangeSchema,
  DevicePairingResultSchema,
  SignedRequestSchema,
  CommandReceiptSchema,
  v.strictObject({
    kind: v.literal("transport.content"),
    transferId: ContentTransferIdSchema,
    streamId: dataStreamId,
    byteLength: safeCounter,
    encoding: v.literal("utf8Json"),
  }),
  v.strictObject({ kind: v.literal("transport.probe"), serial: safeCounter }),
  v.strictObject({ kind: v.literal("transport.echo"), serial: safeCounter }),
  v.strictObject({
    kind: v.literal("stream.reset"),
    streamId: anyStreamId,
    reason: v.picklist(["cancelled", "unknownStream", "overloaded", "contentChanged"]),
  }),
  v.strictObject({
    kind: v.literal("subscription.begin"),
    subscriptionId: SubscriptionIdSchema,
    passId: SyncPassIdSchema,
    base: v.nullable(SyncCursorSchema),
    through: SyncCursorSchema,
    mode: v.picklist(["replace", "merge"]),
  }),
  v.strictObject({
    kind: v.literal("subscription.reset"),
    subscriptionId: SubscriptionIdSchema,
    reason: v.picklist([
      "cursorExpired",
      "rangeChanged",
      "authorizationChanged",
      "databaseGenerationChanged",
      "shapeChanged",
    ]),
  }),
  v.strictObject({
    kind: v.literal("subscription.seal"),
    pages: safeCounter,
    subscriptionId: SubscriptionIdSchema,
    passId: SyncPassIdSchema,
    cursor: SyncCursorSchema,
  }),
  v.strictObject({
    kind: v.literal("subscription.ended"),
    subscriptionId: SubscriptionIdSchema,
    reason: v.picklist([
      "clientClosed",
      "authorizationRevoked",
      "backlogExceeded",
      "acknowledgementTimeout",
    ]),
  }),
]);
export type ControlMessage = v.InferOutput<typeof ControlMessageSchema>;

export const SynchronizedObjectSchema = v.variant("objectType", [
  v.strictObject({ objectType: v.literal("environment"), value: EnvironmentSchema }),
  v.strictObject({ objectType: v.literal("project"), value: ProjectSchema }),
  v.strictObject({ objectType: v.literal("worktree"), value: WorktreeSchema }),
  v.strictObject({ objectType: v.literal("thread"), value: ThreadSchema }),
  v.strictObject({ objectType: v.literal("message"), value: MessageSchema }),
  v.strictObject({ objectType: v.literal("round"), value: RoundSchema }),
  v.strictObject({ objectType: v.literal("todoRequest"), value: TodoRequestSchema }),
  v.strictObject({ objectType: v.literal("checkpointCapture"), value: CheckpointCaptureSchema }),
]);

export const ObjectReplacementSchema = v.strictObject({
  kind: v.literal("object.replace"),
  object: SynchronizedObjectSchema,
});

export const ObjectChangeSchema = v.union([
  TextReturnedEventSchema,
  ContextOperationChangeSchema,
  v.strictObject({
    kind: v.literal("executor.observation"),
    observation: ExecutorSessionObservationSchema,
  }),
  v.strictObject({ kind: v.literal("tool.activity"), item: ToolActivityHistoryItemSchema }),
  v.strictObject({ kind: v.literal("child.resultTransfer"), transfer: ChildResultTransferSchema }),
  v.strictObject({ kind: v.literal("app.noteRead"), observation: AppNoteReadSchema }),
  v.strictObject({ kind: v.literal("thread.summary"), summary: ThreadSummarySchema }),
  v.strictObject({ kind: v.literal("list.counts"), counts: ListCountsSchema }),
  v.strictObject({ kind: v.literal("forge.progress"), operation: ForgeProgressSchema }),
  v.strictObject({ kind: v.literal("forge.observation"), history: ForgeHistorySchema }),
  v.strictObject({
    kind: v.literal("checkpoint.rollbackProgress"),
    progress: RollbackProgressSchema,
  }),

  v.strictObject({ kind: v.literal("worktree.state"), view: WorktreeViewSchema }),
  v.strictObject({ kind: v.literal("attention.facts"), facts: AttentionFactsSchema }),
  ObjectReplacementSchema,
  v.strictObject({
    kind: v.literal("object.remove"),
    key: ObjectKeySchema,
    version: ObjectVersionSchema,
  }),
  v.strictObject({ kind: v.literal("window.enter"), key: ObjectKeySchema }),
  v.strictObject({ kind: v.literal("window.leave"), key: ObjectKeySchema }),
  v.strictObject({
    kind: v.literal("todo.reconcile"),
    todoRequestId: TodoRequestIdSchema,
    result: v.variant("kind", [
      v.strictObject({ kind: v.literal("current"), request: TodoRequestSchema }),
      v.strictObject({ kind: v.literal("removed") }),
      v.strictObject({ kind: v.literal("inaccessible") }),
    ]),
  }),
]);

const fullPage = v.strictObject({
  kind: v.literal("subscription.page"),
  subscriptionId: SubscriptionIdSchema,
  passId: SyncPassIdSchema,
  through: SyncCursorSchema,
  pageNumber: pageIndex,
  pageCount,
  changes: v.array(ObjectChangeSchema),
});
const listPage = v.strictObject({
  ...fullPage.entries,
  through: v.strictObject({
    ...SyncCursorSchema.entries,
    shapeVersion: v.literal(2),
    scope: SyncCursorSchema.entries.scope.options[0],
  }),
  changes: v.array(v.union([ListValueChangeSchema, ObjectChangeSchema])),
});
export const SubscriptionPageSchema = v.union([listPage, fullPage]);
export type SubscriptionPage = v.InferOutput<typeof fullPage>;

export const HistoryPageSchema = v.strictObject({
  kind: v.literal("history.page"),
  threadId: ThreadIdSchema,
  anchor: HistoryAnchorIdSchema,
  verifiedAt: SyncCursorSchema,
  pageNumber: pageIndex,
  pageCount,
  rows: v.array(
    v.union([
      SynchronizedObjectSchema,
      v.strictObject({
        objectType: v.literal("timelineItem"),
        value: TimelineItemSchema,
      }),
    ]),
  ),
  olderAnchor: v.nullable(HistoryAnchorIdSchema),
});
export type HistoryPage = v.InferOutput<typeof HistoryPageSchema>;

/** A page is staged independently. Only a subsequently installed, sealed batch advances the cursor. */
export function readSubscriptionPage(
  raw: unknown,
  installed: v.InferOutput<typeof SyncCursorSchema> | null,
) {
  const parsed = v.safeParse(SubscriptionPageSchema, raw);
  return parsed.success
    ? { kind: "page" as const, page: parsed.output }
    : { kind: "gap" as const, installed };
}

/** The following WebSocket binary payload is exactly byteLength raw bytes. */
export const ContentChunkHeaderSchema = v.pipe(
  v.strictObject({
    kind: v.literal("content.chunk"),
    transferId: ContentTransferIdSchema,
    offsetBytes: safeCounter,
    byteLength: v.pipe(
      v.number(),
      v.safeInteger(),
      v.minValue(1),
      v.maxValue(MAX_FRAME_PAYLOAD_BYTES),
    ),
    payloadEncoding: v.literal("binary"),
  }),
  v.description(
    "The following binary payload has byteLength raw bytes. The complete WebSocket message, including its JSON header, is limited by TransportLimits.maxDataChunkBytes.",
  ),
);
export type ContentChunkHeader = v.InferOutput<typeof ContentChunkHeaderSchema>;

export const DataMessageSchema = v.union([
  v.strictObject({
    kind: v.literal("git.status"),
    subscriptionId: SubscriptionIdSchema,
    snapshot: GitStatusSchema,
  }),
  TerminalSnapshotSchema,
  TerminalOutputSchema,
  SubscriptionPageSchema,
  HistoryPageSchema,
  ContentChunkHeaderSchema,
]);
export type DataMessage = v.InferOutput<typeof DataMessageSchema>;

export const FlowWindowSchema = v.strictObject({
  lane: v.literal("window"),
  epoch: ConnectionIdSchema,
  streamId: anyStreamId,
  consumedBytes: safeCounter,
  limitBytes: v.pipe(
    safeCounter,
    v.description(
      "Absolute send limit. Advance by consumed bytes. At the limit pause only this stream. Control messages take priority between chunks.",
    ),
  ),
});

export const TransportFrameHeaderSchema = v.union([
  v.strictObject({
    lane: v.literal("control"),
    epoch: ConnectionIdSchema,
    streamId: v.literal(0),
    offsetBytes: safeCounter,
    message: ControlMessageSchema,
  }),
  v.strictObject({
    lane: v.literal("data"),
    epoch: ConnectionIdSchema,
    streamId: dataStreamId,
    offsetBytes: safeCounter,
    message: DataMessageSchema,
  }),
  FlowWindowSchema,
]);
export type TransportFrameHeader = v.InferOutput<typeof TransportFrameHeaderSchema>;
export type ControlTransportFrame = Extract<TransportFrameHeader, { lane: "control" }>;
export type SubscriptionDataFrame = Omit<
  Extract<TransportFrameHeader, { lane: "data" }>,
  "message"
> & { message: Exclude<DataMessage, ContentChunkHeader> };
export type BinaryContentFrame = Omit<
  Extract<TransportFrameHeader, { lane: "data" }>,
  "message"
> & { message: ContentChunkHeader; payload: Uint8Array };
export type TransportFrame =
  | ControlTransportFrame
  | SubscriptionDataFrame
  | BinaryContentFrame
  | v.InferOutput<typeof FlowWindowSchema>;

export type FlowWindow = v.InferOutput<typeof FlowWindowSchema>;

export function isValidFlowWindow(window: FlowWindow): boolean {
  return window.consumedBytes <= window.limitBytes;
}

/** Called after parsing the JSON frame header; only binary content frames carry a separate payload. */
export function readBinaryContent(
  header: TransportFrameHeader,
  payload: Uint8Array,
  headerByteLength: number,
): BinaryContentFrame | null {
  if (
    header.lane !== "data" ||
    header.message.kind !== "content.chunk" ||
    header.message.byteLength !== payload.byteLength ||
    !Number.isSafeInteger(headerByteLength) ||
    headerByteLength < 2 ||
    4 + headerByteLength + payload.byteLength > TRANSPORT_LIMITS.maxDataChunkBytes
  )
    return null;
  return { ...header, message: header.message, payload };
}

export const TransportSchema = {
  TransportLimits: TransportLimitsSchema,
  ServerHello: ServerHelloSchema,
  ConnectionChallenge: ConnectionChallengeSchema,
  ClientAuthentication: ClientAuthenticationSchema,
  SessionAuthorized: SessionAuthorizedSchema,
  SessionConfiguration: SessionConfigurationSchema,
  SessionRejected: SessionRejectedSchema,
  PairingRequest: PairingRequestSchema,
  PairingPending: PairingPendingSchema,
  PairingChallenge: PairingChallengeSchema,
  PairingExchange: PairingExchangeSchema,
  DevicePairingResult: DevicePairingResultSchema,
  SignedRequest: SignedRequestSchema,
  CommandReceipt: CommandReceiptSchema,
  ControlMessage: ControlMessageSchema,
  SynchronizedObject: SynchronizedObjectSchema,
  ObjectReplacement: ObjectReplacementSchema,
  ObjectKey: ObjectKeySchema,
  ObjectChange: ObjectChangeSchema,
  SubscriptionPage: SubscriptionPageSchema,
  HistoryPage: HistoryPageSchema,
  ContentChunkHeader: ContentChunkHeaderSchema,
  DataMessage: DataMessageSchema,
  FlowWindow: FlowWindowSchema,
  TransportFrameHeader: TransportFrameHeaderSchema,
  ProtocolVersion: ProtocolVersionSchema,
  ProtocolFeatureSet: ProtocolFeatureSetSchema,
};
