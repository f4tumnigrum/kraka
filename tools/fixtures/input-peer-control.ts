import {
  AttemptIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";

export const entrySchema = v.object({
  step: v.string(),
  attemptId: AttemptIdSchema,
  deliveryId: DeliveryIdSchema,
  messageId: MessageIdSchema,
  sessionId: NativeSessionIdSchema,
  data: v.unknown(),
});
export type PeerEntry = v.InferOutput<typeof entrySchema>;
export const turnAction = v.variant("kind", [
  v.object({ kind: v.literal("resume") }),
  v.object({ kind: v.literal("late"), source: entrySchema }),
  v.object({ kind: v.literal("steer"), messageId: MessageIdSchema, deliveryId: DeliveryIdSchema }),
]);
export const commandSchema = v.variant("kind", [
  v.object({ kind: v.literal("seen"), step: v.string(), deliveryId: DeliveryIdSchema }),
  v.object({ kind: v.literal("ledger") }),
  v.object({ kind: v.literal("hold"), step: v.string() }),
  v.object({ kind: v.literal("release"), step: v.string() }),
  v.object({ kind: v.literal("releaseAll") }),
  v.object({ kind: v.literal("late"), attemptId: AttemptIdSchema, source: entrySchema }),
]);
export type PeerCommand = v.InferOutput<typeof commandSchema>;
