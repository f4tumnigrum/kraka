import * as v from "valibot";
import {
  AttemptIdSchema,
  ExecutorInstanceIdSchema,
  NativeItemIdSchema,
  NativeRequestIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  SyncPositionSchema,
  ThreadIdSchema,
  TimelineItemIdSchema,
} from "./ids";

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const epoch = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const source = {
  instanceId: ExecutorInstanceIdSchema,
  nativeSessionId: NativeSessionIdSchema,
  epoch,
  eventId: v.pipe(v.string(), v.minLength(1)),
  sourceId: v.pipe(v.string(), v.minLength(1)),
};
export const NativeObservationRelationshipSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("root"), nativeRootTurnId: NativeRootTurnIdSchema }),
  v.strictObject({ kind: v.literal("item"), nativeItemId: NativeItemIdSchema }),
  v.strictObject({ kind: v.literal("request"), nativeRequestId: NativeRequestIdSchema }),
]);
const assignment = v.variant("kind", [
  v.strictObject({ kind: v.literal("session") }),
  v.strictObject({
    kind: v.literal("attempt"),
    attemptId: AttemptIdSchema,
    relationship: NativeObservationRelationshipSchema,
  }),
]);

/** Adapters publish only a sanitized summary when the source event cannot be assigned to an attempt. */
export const ExecutorSessionObservationPayloadSchema = v.strictObject({
  category: v.picklist(["turn", "content", "toolActivity", "request", "history", "other"]),
  observedAt: time,
  redactedSummary: v.string(),
});
export const ExecutorSessionObservationSchema = v.strictObject({
  kind: v.literal("executorObservation"),
  id: TimelineItemIdSchema,
  threadId: ThreadIdSchema,
  source: v.strictObject(source),
  ...ExecutorSessionObservationPayloadSchema.entries,
  assignment,
  createdPosition: SyncPositionSchema,
  version: ObjectVersionSchema,
});
/** Tool rows retain native call identity and their own creation order and object version. */
export const ToolActivityHistoryItemSchema = v.strictObject({
  kind: v.literal("toolActivity"),
  id: TimelineItemIdSchema,
  threadId: ThreadIdSchema,
  source: v.strictObject({ ...source, callId: NativeItemIdSchema }),
  assignment,
  phase: v.picklist(["started", "progress", "ended"]),
  inputSummary: v.nullable(v.string()),
  outputSummary: v.nullable(v.string()),
  createdAt: time,
  createdPosition: SyncPositionSchema,
  version: ObjectVersionSchema,
});
export const TimelineItemSchema = v.variant("kind", [
  ExecutorSessionObservationSchema,
  ToolActivityHistoryItemSchema,
]);
export type ExecutorSessionObservationPayload = v.InferOutput<
  typeof ExecutorSessionObservationPayloadSchema
>;
export type ExecutorSessionObservation = v.InferOutput<typeof ExecutorSessionObservationSchema>;
export type ToolActivityHistoryItem = v.InferOutput<typeof ToolActivityHistoryItemSchema>;
export type NativeObservationRelationship = v.InferOutput<
  typeof NativeObservationRelationshipSchema
>;
export const timelineSchemas = {
  ExecutorSessionObservationPayload: ExecutorSessionObservationPayloadSchema,
  ExecutorSessionObservation: ExecutorSessionObservationSchema,
  ToolActivityHistoryItem: ToolActivityHistoryItemSchema,
  TimelineItem: TimelineItemSchema,
};
