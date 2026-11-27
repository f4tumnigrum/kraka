import * as v from "valibot";
import {
  DeliveryIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  ThreadIdSchema,
} from "./ids";

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const accepted = v.strictObject({ kind: v.literal("accepted"), acceptedAt: time });
const unknown = v.strictObject({ kind: v.literal("unknown"), acceptedAt: time, observedAt: time });
const operation = {
  threadId: ThreadIdSchema,
  deliveryId: DeliveryIdSchema,
  version: ObjectVersionSchema,
};
const compactCompleted = v.strictObject({
  kind: v.literal("completed"),
  completedAt: time,
  summary: v.nullable(v.string()),
  firstKeptEntryId: v.nullable(v.string()),
});
const clearCompleted = v.strictObject({
  kind: v.literal("completed"),
  completedAt: time,
  nativeSessionId: NativeSessionIdSchema,
});
const failed = v.strictObject({
  kind: v.literal("failed"),
  failedAt: time,
  reason: v.pipe(v.string(), v.minLength(1)),
});
const uncertain = v.omit(unknown, ["acceptedAt"]);

/** Receipt and subscription identify the same delivery. A clear completes after the fresh binding commits. */
export const ContextOperationSchema = v.variant("action", [
  v.strictObject({
    ...operation,
    action: v.literal("compact"),
    state: v.variant("kind", [
      accepted,
      unknown,
      v.strictObject({ ...compactCompleted.entries, acceptedAt: time }),
      v.strictObject({ ...failed.entries, acceptedAt: time }),
    ]),
  }),
  v.strictObject({
    ...operation,
    action: v.literal("clear"),
    state: v.variant("kind", [
      accepted,
      unknown,
      v.strictObject({ ...clearCompleted.entries, acceptedAt: time }),
      v.strictObject({ ...failed.entries, acceptedAt: time }),
    ]),
  }),
]);
export const ContextOperationObservationSchema = v.variant("action", [
  v.strictObject({
    action: v.literal("compact"),
    threadId: ThreadIdSchema,
    deliveryId: DeliveryIdSchema,
    state: v.variant("kind", [accepted, compactCompleted, failed, uncertain]),
  }),
  v.strictObject({
    action: v.literal("clear"),
    threadId: ThreadIdSchema,
    deliveryId: DeliveryIdSchema,
    state: v.variant("kind", [accepted, clearCompleted, failed, uncertain]),
  }),
]);
export const ContextOperationReceiptSchema = v.strictObject({
  kind: v.literal("contextOperation"),
  operation: ContextOperationSchema,
});
export const ContextOperationChangeSchema = v.strictObject({
  kind: v.literal("context.operation"),
  operation: ContextOperationSchema,
});
export type ContextOperation = v.InferOutput<typeof ContextOperationSchema>;
export type ContextOperationObservation = v.InferOutput<typeof ContextOperationObservationSchema>;
export type ContextOperationReceipt = v.InferOutput<typeof ContextOperationReceiptSchema>;

export const contextOperationSchemas = {
  ContextOperation: ContextOperationSchema,
  ContextOperationObservation: ContextOperationObservationSchema,
  ContextOperationReceipt: ContextOperationReceiptSchema,
};
