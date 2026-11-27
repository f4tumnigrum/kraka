import * as v from "valibot";

function identifierSchema<const TName extends string>(name: TName) {
  return v.pipe(v.string(), v.minLength(1), v.brand(name));
}

export const EnvironmentIdSchema = identifierSchema("EnvironmentId");
export const ProjectIdSchema = identifierSchema("ProjectId");
export const WorktreeIdSchema = identifierSchema("WorktreeId");
export const ThreadIdSchema = identifierSchema("ThreadId");
export const RoundIdSchema = identifierSchema("RoundId");
export const MessageIdSchema = identifierSchema("MessageId");
export const AttachmentIdSchema = identifierSchema("AttachmentId");
export const TodoRequestIdSchema = identifierSchema("TodoRequestId");
export const PrincipalIdSchema = identifierSchema("PrincipalId");
export const ExecutorInstanceIdSchema = identifierSchema("ExecutorInstanceId");
export const CommandIdSchema = identifierSchema("CommandId");
export const AttemptIdSchema = identifierSchema("AttemptId");
export const DeliveryIdSchema = identifierSchema("DeliveryId");
export const TerminalIdSchema = identifierSchema("TerminalId");
export const CaptureIdSchema = identifierSchema("CaptureId");
export const WorkNodeIdSchema = identifierSchema("WorkNodeId");
export const DeviceIdSchema = identifierSchema("DeviceId");
export const DeviceKeyIdSchema = identifierSchema("DeviceKeyId");
export const ExecutorKeyIdSchema = identifierSchema("ExecutorKeyId");
export const PairingInviteIdSchema = identifierSchema("PairingInviteId");
export const PairingRequestIdSchema = identifierSchema("PairingRequestId");
export const PairingClaimIdSchema = identifierSchema("PairingClaimId");
export const AccessGrantIdSchema = identifierSchema("AccessGrantId");
export const ConnectionIdSchema = identifierSchema("ConnectionId");
export const ConnectionChallengeIdSchema = identifierSchema("ConnectionChallengeId");
export const EnvironmentSessionIdSchema = identifierSchema("EnvironmentSessionId");
export const SubscriptionIdSchema = identifierSchema("SubscriptionId");
export const ContentTransferIdSchema = identifierSchema("ContentTransferId");
export const RouteIdSchema = identifierSchema("RouteId");
export const HostInstanceIdSchema = identifierSchema("HostInstanceId");
export const SyncPassIdSchema = identifierSchema("SyncPassId");
export const HistoryAnchorIdSchema = identifierSchema("HistoryAnchorId");
export const ContextTransferIdSchema = identifierSchema("ContextTransferId");
export const ChildResultTransferIdSchema = identifierSchema("ChildResultTransferId");
export const PortServiceIdSchema = identifierSchema("PortServiceId");
export const PortTicketIdSchema = identifierSchema("PortTicketId");
export const PortMappingIdSchema = identifierSchema("PortMappingId");
export const BrowserProfileIdSchema = identifierSchema("BrowserProfileId");
export const PreviewNavigationIdSchema = identifierSchema("PreviewNavigationId");
export const PreviewSnapshotIdSchema = identifierSchema("PreviewSnapshotId");
export const PreviewTabIdSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/),
  v.brand("PreviewTabId"),
);
export const EnvironmentGenerationSchema = v.pipe(
  v.string(),
  v.regex(/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/),
  v.brand("EnvironmentGeneration"),
);

export const NativeSessionIdSchema = identifierSchema("NativeSessionId");
export const ChildTaskIdSchema = identifierSchema("ChildTaskId");
export const TimelineItemIdSchema = identifierSchema("TimelineItemId");
export const NativeItemIdSchema = identifierSchema("NativeItemId");
export const NativeRequestIdSchema = identifierSchema("NativeRequestId");
export const NativeRootTurnIdSchema = identifierSchema("NativeRootTurnId");

function canonicalCounterSchema<const TName extends string>(name: TName) {
  return v.pipe(v.string(), v.regex(/^(0|[1-9][0-9]*)$/), v.brand(name));
}

export const TerminalOffsetSchema = canonicalCounterSchema("TerminalOffset");
export const TerminalGenerationSchema = canonicalCounterSchema("TerminalGeneration");
export const WorktreeGenerationSchema = canonicalCounterSchema("WorktreeGeneration");
export const ObjectVersionSchema = canonicalCounterSchema("ObjectVersion");
export const QueuePositionSchema = canonicalCounterSchema("QueuePosition");
export const SyncPositionSchema = canonicalCounterSchema("SyncPosition");
export const SyncCursorSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  databaseGeneration: v.pipe(v.string(), v.minLength(1)),
  visibilityGeneration: v.pipe(v.string(), v.minLength(1)),
  scope: v.variant("kind", [
    v.strictObject({ kind: v.literal("list"), projectId: v.nullable(ProjectIdSchema) }),
    v.strictObject({ kind: v.literal("thread"), threadId: ThreadIdSchema }),
  ]),
  shapeVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65_535)),
  through: SyncPositionSchema,
});

export type EnvironmentId = v.InferOutput<typeof EnvironmentIdSchema>;
export type ProjectId = v.InferOutput<typeof ProjectIdSchema>;
export type WorktreeId = v.InferOutput<typeof WorktreeIdSchema>;
export type ThreadId = v.InferOutput<typeof ThreadIdSchema>;
export type RoundId = v.InferOutput<typeof RoundIdSchema>;
export type MessageId = v.InferOutput<typeof MessageIdSchema>;
export type AttachmentId = v.InferOutput<typeof AttachmentIdSchema>;
export type TodoRequestId = v.InferOutput<typeof TodoRequestIdSchema>;
export type PrincipalId = v.InferOutput<typeof PrincipalIdSchema>;
export type ExecutorInstanceId = v.InferOutput<typeof ExecutorInstanceIdSchema>;
export type CommandId = v.InferOutput<typeof CommandIdSchema>;
export type AttemptId = v.InferOutput<typeof AttemptIdSchema>;
export type DeliveryId = v.InferOutput<typeof DeliveryIdSchema>;
export type CaptureId = v.InferOutput<typeof CaptureIdSchema>;
export type WorkNodeId = v.InferOutput<typeof WorkNodeIdSchema>;
export type DeviceId = v.InferOutput<typeof DeviceIdSchema>;
export type DeviceKeyId = v.InferOutput<typeof DeviceKeyIdSchema>;
export type ExecutorKeyId = v.InferOutput<typeof ExecutorKeyIdSchema>;
export type PairingInviteId = v.InferOutput<typeof PairingInviteIdSchema>;
export type PairingRequestId = v.InferOutput<typeof PairingRequestIdSchema>;
export type PairingClaimId = v.InferOutput<typeof PairingClaimIdSchema>;
export type AccessGrantId = v.InferOutput<typeof AccessGrantIdSchema>;
export type ConnectionId = v.InferOutput<typeof ConnectionIdSchema>;
export type ConnectionChallengeId = v.InferOutput<typeof ConnectionChallengeIdSchema>;
export type EnvironmentSessionId = v.InferOutput<typeof EnvironmentSessionIdSchema>;
export type SubscriptionId = v.InferOutput<typeof SubscriptionIdSchema>;
export type ContentTransferId = v.InferOutput<typeof ContentTransferIdSchema>;
export type RouteId = v.InferOutput<typeof RouteIdSchema>;
export type HostInstanceId = v.InferOutput<typeof HostInstanceIdSchema>;
export type SyncPassId = v.InferOutput<typeof SyncPassIdSchema>;
export type HistoryAnchorId = v.InferOutput<typeof HistoryAnchorIdSchema>;
export type ContextTransferId = v.InferOutput<typeof ContextTransferIdSchema>;
export type ChildResultTransferId = v.InferOutput<typeof ChildResultTransferIdSchema>;
export type PortServiceId = v.InferOutput<typeof PortServiceIdSchema>;
export type PortTicketId = v.InferOutput<typeof PortTicketIdSchema>;
export type PortMappingId = v.InferOutput<typeof PortMappingIdSchema>;
export type BrowserProfileId = v.InferOutput<typeof BrowserProfileIdSchema>;
export type PreviewNavigationId = v.InferOutput<typeof PreviewNavigationIdSchema>;
export type PreviewSnapshotId = v.InferOutput<typeof PreviewSnapshotIdSchema>;
export type PreviewTabId = v.InferOutput<typeof PreviewTabIdSchema>;
export type EnvironmentGeneration = v.InferOutput<typeof EnvironmentGenerationSchema>;

export type NativeSessionId = v.InferOutput<typeof NativeSessionIdSchema>;
export type TimelineItemId = v.InferOutput<typeof TimelineItemIdSchema>;
export type NativeItemId = v.InferOutput<typeof NativeItemIdSchema>;
export type NativeRequestId = v.InferOutput<typeof NativeRequestIdSchema>;
export type NativeRootTurnId = v.InferOutput<typeof NativeRootTurnIdSchema>;
export type ObjectVersion = v.InferOutput<typeof ObjectVersionSchema>;
export type QueuePosition = v.InferOutput<typeof QueuePositionSchema>;
export type SyncPosition = v.InferOutput<typeof SyncPositionSchema>;
export type SyncCursor = v.InferOutput<typeof SyncCursorSchema>;

export type TerminalId = v.InferOutput<typeof TerminalIdSchema>;
export type TerminalOffset = v.InferOutput<typeof TerminalOffsetSchema>;
export type TerminalGeneration = v.InferOutput<typeof TerminalGenerationSchema>;
export type WorktreeGeneration = v.InferOutput<typeof WorktreeGenerationSchema>;
