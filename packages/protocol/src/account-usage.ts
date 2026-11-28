import * as v from "valibot";
import {
  ExecutorInstanceIdSchema,
  ObjectVersionSchema,
  NativeSessionIdSchema,
  RoundIdSchema,
  ThreadIdSchema,
} from "./ids";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const amount = v.pipe(v.number(), v.minValue(0), v.maxValue(Number.MAX_VALUE));
const name = v.pipe(v.string(), v.minLength(1));
const percent = v.pipe(amount, v.maxValue(100));
export const QuotaSourceSchema = v.strictObject({
  instanceId: ExecutorInstanceIdSchema,
  credentialVersion: v.nullable(ObjectVersionSchema),
  account: v.nullable(name),
  endpoint: name,
});
export const QuotaWindowSchema = v.strictObject({
  id: name,
  kind: name,
  unit: v.literal("percent"),
  durationMinutes: v.nullable(count),
  used: v.nullable(percent),
  remaining: v.nullable(percent),
  resetAt: v.nullable(count),
});
export type QuotaWindow = v.InferOutput<typeof QuotaWindowSchema>;
const failure = v.picklist(["unsupported", "probeFailed"]);
const state = v.variant("kind", [
  v.strictObject({ kind: v.literal("neverObserved") }),
  v.strictObject({ kind: v.literal("fresh") }),
  v.strictObject({
    kind: v.literal("stale"),
    reason: v.union([failure, v.literal("resetReached")]),
  }),
  v.strictObject({ kind: v.literal("unavailable"), reason: failure }),
]);
export const AccountQuotaSnapshotSchema = v.strictObject({
  source: QuotaSourceSchema,
  version: count,
  lastSuccessAt: v.nullable(count),
  lastAttemptAt: v.nullable(count),
  outcome: v.nullable(v.union([failure, v.literal("success")])),
  state,
  windows: v.array(
    v.strictObject({ ...QuotaWindowSchema.entries, observedAt: count, stale: v.boolean() }),
  ),
});
export type AccountQuotaSnapshot = v.InferOutput<typeof AccountQuotaSnapshotSchema>;
export const TokenCountersSchema = v.strictObject({
  uncachedInput: v.nullable(count),
  cacheRead: v.nullable(count),
  cacheWrite: v.nullable(count),
  output: v.nullable(count),
  reasoning: v.nullable(count),
  total: v.nullable(count),
});
export const ModelRatesSchema = v.strictObject({
  kind: v.literal("modelRates"),
  models: v.record(
    name,
    v.strictObject({
      currency: name,
      uncachedInput: v.optional(amount),
      cacheRead: v.optional(amount),
      cacheWrite: v.optional(amount),
      output: v.optional(amount),
    }),
  ),
});
export type ModelRates = v.InferOutput<typeof ModelRatesSchema>;
export const UsageBucketSchema = v.strictObject({
  instanceId: ExecutorInstanceIdSchema,
  threadId: ThreadIdSchema,
  nativeSessionId: NativeSessionIdSchema,
  sourceId: name,
  scope: v.variant("kind", [
    v.strictObject({ kind: v.literal("round"), roundId: RoundIdSchema }),
    v.strictObject({ kind: v.literal("session") }),
    v.strictObject({ kind: v.literal("step"), roundId: RoundIdSchema, stepId: name }),
  ]),
  model: name,
  observedAt: count,
  counters: TokenCountersSchema,
  amount: v.nullable(amount),
  currency: v.nullable(name),
  priceSource: v.picklist(["unknown", "custom", "reported", "providerEstimated", "catalog"]),
  priceVersion: v.nullable(ObjectVersionSchema),
  unpricedRecords: count,
});
export type UsageBucket = v.InferOutput<typeof UsageBucketSchema>;
export const UsageReadSchema = v.strictObject({
  kind: v.literal("threadUsage"),
  threadId: ThreadIdSchema,
  buckets: v.array(UsageBucketSchema),
  limits: v.array(
    v.strictObject({
      roundId: RoundIdSchema,
      failure: v.literal("usageLimit"),
      resetAt: v.nullable(count),
      autoResume: v.boolean(),
      recovery: v.literal("waitingForManualRetry"),
    }),
  ),
});
