import * as v from "valibot";
import {
  ContentTransferIdSchema,
  ObjectVersionSchema,
  SubscriptionIdSchema,
  ThreadIdSchema,
  TimelineItemIdSchema,
} from "./ids";
import { ToolActivityHistoryItemSchema } from "./timeline";

const capturedInput = v.variant("kind", [
  v.strictObject({ kind: v.literal("unobserved") }),
  v.strictObject({ kind: v.literal("captured"), json: v.string() }),
]);
const capturedOutput = v.variant("kind", [
  v.strictObject({ kind: v.literal("unobserved") }),
  v.strictObject({ kind: v.literal("partial"), text: v.string(), truncated: v.boolean() }),
  v.strictObject({ kind: v.literal("complete"), text: v.string() }),
]);

export const ToolActivityFileChangeSchema = v.strictObject({
  path: v.pipe(v.string(), v.minLength(1)),
  change: v.picklist(["created", "modified", "deleted", "moved"]),
  destination: v.nullable(v.pipe(v.string(), v.minLength(1))),
  patch: v.nullable(v.string()),
});

export const ToolActivityBodySchema = v.strictObject({
  input: capturedInput,
  output: capturedOutput,
  status: v.picklist(["running", "completed", "failed", "unknown"]),
  exitCode: v.nullable(v.pipe(v.number(), v.safeInteger())),
  success: v.nullable(v.boolean()),
  changes: v.array(ToolActivityFileChangeSchema),
});

export const ToolActivityContentSchema = v.strictObject({
  item: ToolActivityHistoryItemSchema,
  body: ToolActivityBodySchema,
});
export const ToolActivityReferenceSchema = v.strictObject({
  threadId: ThreadIdSchema,
  itemId: TimelineItemIdSchema,
  version: ObjectVersionSchema,
  byteLength: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});

export const ToolActivityDetailFrameSchema = v.strictObject({
  kind: v.literal("tool.activity.detail"),
  subscriptionId: SubscriptionIdSchema,
  reference: ToolActivityReferenceSchema,
  transferId: ContentTransferIdSchema,
});

export const ToolActivityReadResultSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("activityReadStarted"),
    subscriptionId: SubscriptionIdSchema,
    streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  }),
  v.strictObject({
    kind: v.literal("activityVersionExpired"),
    replacement: ToolActivityReferenceSchema,
  }),
  v.strictObject({ kind: v.literal("activityUnsupported") }),
]);

export type ToolActivityBody = v.InferOutput<typeof ToolActivityBodySchema>;
export type ToolActivityFileChange = v.InferOutput<typeof ToolActivityFileChangeSchema>;
export type ToolActivityReference = v.InferOutput<typeof ToolActivityReferenceSchema>;
export type ToolActivityDetailFrame = v.InferOutput<typeof ToolActivityDetailFrameSchema>;
export type ToolActivityReadResult = v.InferOutput<typeof ToolActivityReadResultSchema>;

export const toolActivitySchemas = {
  ToolActivityFileChange: ToolActivityFileChangeSchema,
  ToolActivityBody: ToolActivityBodySchema,
  ToolActivityContent: ToolActivityContentSchema,
  ToolActivityReference: ToolActivityReferenceSchema,
  ToolActivityDetailFrame: ToolActivityDetailFrameSchema,
  ToolActivityReadResult: ToolActivityReadResultSchema,
};
