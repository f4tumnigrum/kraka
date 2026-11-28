import * as v from "valibot";
import {
  AttemptIdSchema,
  CaptureIdSchema,
  DeliveryIdSchema,
  DeviceIdSchema,
  MessageIdSchema,
  NativeItemIdSchema,
  NativeRequestIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  PrincipalIdSchema,
  WorkNodeIdSchema,
  CommandIdSchema,
} from "./ids";

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const gate = v.picklist(["eligible", "held"]);
const ticket = { attemptId: AttemptIdSchema, deliveryId: DeliveryIdSchema };
export const ReceiptProofSchema = v.strictObject({
  sessionId: NativeSessionIdSchema,
  itemId: NativeItemIdSchema,
});
export const NativeRootSchema = v.strictObject({
  sessionId: NativeSessionIdSchema,
  id: NativeRootTurnIdSchema,
  beganAt: v.nullable(time),
});
/** These are independently observed UTC Unix milliseconds. Unknown evidence is reserved for older recordings. */
export const RoundEndTimeEvidenceSchema = v.variant("source", [
  v.strictObject({
    source: v.literal("executorReported"),
    executorEndedAt: time,
    environmentObservedAt: v.nullable(time),
  }),
  v.strictObject({
    source: v.literal("environmentObserved"),
    executorEndedAt: v.nullable(time),
    environmentObservedAt: time,
  }),
  v.strictObject({
    source: v.literal("unknown"),
    executorEndedAt: v.null(),
    environmentObservedAt: v.null(),
  }),
]);
export type RoundEndTimeEvidence = v.InferOutput<typeof RoundEndTimeEvidenceSchema>;
const executing = { root: NativeRootSchema, receipt: v.nullable(ReceiptProofSchema) };
const closed = {
  ...executing,
  endedAt: time,
  endTimeEvidence: v.optional(RoundEndTimeEvidenceSchema),
  nativeReason: v.optional(v.nullable(v.string())),
};
const written = v.strictObject({ kind: v.literal("handed"), wroteAt: time });
const armed = v.strictObject({ kind: v.literal("armed") });

/** Only the control plane changes an attempt. A write timestamp proves that bytes left the adapter. */
export const RoundPhaseSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("filed"), gate }),
  armed,
  written,
  v.strictObject({
    kind: v.literal("recovering"),
    prior: v.union([armed, written]),
    gate,
    action: v.picklist(["retrySameDelivery", "inspectInput"]),
  }),
  v.strictObject({ kind: v.literal("uncertain"), next: v.literal("inspectInput") }),
  v.strictObject({ kind: v.literal("received"), proof: ReceiptProofSchema }),
  v.strictObject({ kind: v.literal("working"), ...executing }),
  v.strictObject({
    kind: v.literal("unobserved"),
    seen: v.variant("kind", [
      v.strictObject({ kind: v.literal("input"), proof: ReceiptProofSchema }),
      v.strictObject({ kind: v.literal("root"), ...executing }),
    ]),
    next: v.literal("inspectRoot"),
  }),
  v.strictObject({ kind: v.literal("closing"), ...closed, captureId: CaptureIdSchema }),
  v.strictObject({ kind: v.literal("finished"), ...closed, captureId: CaptureIdSchema }),
  v.strictObject({
    kind: v.literal("endedEarly"),
    ...closed,
    reason: v.picklist(["failed", "stopped", "lost", "superseded", "unknown"]),
    failure: v.optional(v.strictObject({kind:v.string(),message:v.string()})),
  }),
  v.strictObject({
    kind: v.literal("notDelivered"),
    reason: v.string(),
    lateReceipt: v.nullable(ReceiptProofSchema),
  }),
]);
export const RoundAttemptSchema = v.strictObject({ ...ticket, phase: RoundPhaseSchema });
const liveTarget = { sessionId: NativeSessionIdSchema, requestId: NativeRequestIdSchema };
const questions = v.tupleWithRest([MessageIdSchema], MessageIdSchema);
const messageTarget = { questions, nodeId: WorkNodeIdSchema };
const expire = v.strictObject({ kind: v.literal("expire") });
export const TodoRouteSchema = v.union([
  v.strictObject({
    kind: v.literal("live"),
    subject: v.picklist(["approval", "secret"]),
    ...liveTarget,
    fallback: expire,
  }),
  v.strictObject({
    kind: v.literal("live"),
    subject: v.literal("question"),
    ...liveTarget,
    fallback: v.union([expire, v.strictObject({ kind: v.literal("asMessage"), ...messageTarget })]),
  }),
  v.strictObject({ kind: v.literal("message"), subject: v.literal("question"), ...messageTarget }),
]);
export const AnswerProofSchema = v.strictObject(liveTarget);
/** For a message answer, the linked message's round owns delivery progress. */
export const AnswerArrivalSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("viaMessage") }),
  v.strictObject({ kind: v.literal("recorded") }),
  armed,
  written,
  v.strictObject({ kind: v.literal("uncertain"), next: v.literal("inspectAnswer") }),
  v.strictObject({ kind: v.literal("received"), proof: AnswerProofSchema }),
  v.strictObject({ kind: v.literal("rejected"), reason: v.string() }),
]);
/** A secret answer points to the acceptance receipt in secret storage. Devices can read its status. */
export const TodoAnswerSchema = v.strictObject({
  authorId: PrincipalIdSchema,
  deviceId: v.optional(DeviceIdSchema),
  at: time,
  ...ticket,
  content: v.variant("kind", [
    v.strictObject({ kind: v.literal("message"), messageId: MessageIdSchema }),
    v.strictObject({ kind: v.literal("secretReceipt"), commandId: CommandIdSchema }),
  ]),
});
export const AnswerAttemptSchema = v.strictObject({
  attemptId: AttemptIdSchema,
  deliveryId: DeliveryIdSchema,
  arrival: AnswerArrivalSchema,
});
export const TodoStateSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("open"), route: TodoRouteSchema }),
  v.strictObject({
    kind: v.literal("answered"),
    route: TodoRouteSchema,
    answer: TodoAnswerSchema,
    arrival: AnswerArrivalSchema,
    previousAttempts: v.array(AnswerAttemptSchema),
  }),
  v.strictObject({ kind: v.literal("expired"), reason: v.string() }),
]);

export type ReceiptProof = v.InferOutput<typeof ReceiptProofSchema>;
export type NativeRoot = v.InferOutput<typeof NativeRootSchema>;
export type RoundPhase = v.InferOutput<typeof RoundPhaseSchema>;
export type RoundAttempt = v.InferOutput<typeof RoundAttemptSchema>;
export type TodoRoute = v.InferOutput<typeof TodoRouteSchema>;
export type AnswerProof = v.InferOutput<typeof AnswerProofSchema>;
export type AnswerArrival = v.InferOutput<typeof AnswerArrivalSchema>;
export type TodoAnswer = v.InferOutput<typeof TodoAnswerSchema>;
export type AnswerAttempt = v.InferOutput<typeof AnswerAttemptSchema>;
export type TodoState = v.InferOutput<typeof TodoStateSchema>;
