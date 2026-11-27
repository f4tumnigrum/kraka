import * as v from "valibot";
import {
  RoundIdSchema,
  ObjectVersionSchema,
  ThreadIdSchema,
  MessageIdSchema,
  QueuePositionSchema,
} from "./ids";
export const QueuedTargetSchema = v.strictObject({
  threadId: ThreadIdSchema,
  roundId: RoundIdSchema,
  baseVersion: ObjectVersionSchema,
});
export const QueueOrderSchema = v.strictObject({
  threadId: ThreadIdSchema,
  baseVersion: ObjectVersionSchema,
  roundIds: v.array(RoundIdSchema),
});
export const QueueConflictSchema = v.strictObject({
  kind: v.literal("queueConflict"),
  threadId: ThreadIdSchema,
  roundId: v.nullable(RoundIdSchema),
  currentVersion: v.nullable(ObjectVersionSchema),
  reason: v.picklist(["changed", "leftQueue"]),
});
export const QueueUpdateSchema = v.strictObject({
  threadId: ThreadIdSchema,
  version: ObjectVersionSchema,
  change: v.variant("kind", [
    v.strictObject({
      kind: v.literal("edited"),
      roundId: RoundIdSchema,
      messageId: MessageIdSchema,
      messageVersion: ObjectVersionSchema,
    }),
    v.strictObject({ kind: v.literal("cancelled"), roundId: RoundIdSchema }),
    v.strictObject({
      kind: v.literal("reordered"),
      positions: v.array(v.strictObject({ roundId: RoundIdSchema, place: QueuePositionSchema })),
    }),
  ]),
});
export type QueueUpdate = v.InferOutput<typeof QueueUpdateSchema>;
