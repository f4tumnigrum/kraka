import * as v from "valibot";
import { AdapterFamilySchema, InstancePermissionSchema } from "./executor-capabilities";
import { ChildModelSchema } from "./executor-tools";
import { HistoryCoverageSchema, HandoffSourceSchema } from "./handoffs";
import {
  AttemptIdSchema,
  CommandIdSchema,
  ContextTransferIdSchema,
  DeliveryIdSchema,
  ExecutorInstanceIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  RoundIdSchema,
  ThreadIdSchema,
} from "./ids";
import { WorkRelationshipSchema } from "./objects";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const SessionPreviewIdSchema = v.pipe(
  v.string(),
  v.minLength(1),
  v.brand("SessionPreviewId"),
);
export const SessionBindingSchema = v.strictObject({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  nativeSessionId: v.nullable(NativeSessionIdSchema),
  epoch: count,
  threadId: ThreadIdSchema,
  attemptId: AttemptIdSchema,
});
export const HandoffEntrySchema = v.strictObject({
  id: MessageIdSchema,
  version: ObjectVersionSchema,
  role: v.picklist(["user", "assistant"]),
  text: v.string(),
});
export const HandoffBudgetSchema = v.strictObject({
  catalogVersion: count,
  windowTokens: count,
  windowSource: v.picklist(["reported", "estimated"]),
  workTokens: count,
  inputTokens: count,
  allowanceTokens: count,
  historyTokens: count,
  historyBytes: count,
});
const target = v.strictObject({
  instanceId: ExecutorInstanceIdSchema,
  family: AdapterFamilySchema,
  account: v.string(),
  model: ChildModelSchema,
  configurationVersion: ObjectVersionSchema,
  capabilityVersion: count,
  catalogVersion: count,
  permission: InstancePermissionSchema,
});
const common = {
  id: SessionPreviewIdSchema,
  threadId: ThreadIdSchema,
  source: v.nullable(HandoffSourceSchema),
  expectedBinding: v.nullable(SessionBindingSchema),
};
const approved = {
  ...common,
  target,
  entries: v.array(HandoffEntrySchema),
  history: HistoryCoverageSchema,
  budget: HandoffBudgetSchema,
};
export const SessionTransitionPreviewSchema = v.variant("kind", [
  v.strictObject({ ...approved, kind: v.literal("reuseSession") }),
  v.strictObject({
    ...approved,
    kind: v.literal("resumeSession"),
    nativeSessionId: NativeSessionIdSchema,
  }),
  v.strictObject({
    ...approved,
    kind: v.literal("changeModel"),
    effectiveAt: v.picklist(["now", "nextTurn"]),
  }),
  v.strictObject({
    ...approved,
    source: HandoffSourceSchema,
    kind: v.literal("createWithHandoff"),
  }),
  v.strictObject({
    ...common,
    kind: v.literal("reject"),
    targetInstanceId: ExecutorInstanceIdSchema,
    model: ChildModelSchema,
    reason: v.picklist([
      "invalidState",
      "targetUnavailable",
      "unsupported",
      "inputTooLarge",
      "sourceUnavailable",
    ]),
  }),
]);
const readback = {
  operationId: CommandIdSchema,
  threadId: ThreadIdSchema,
  target,
  priorBinding: v.nullable(SessionBindingSchema),
  currentBinding: v.nullable(SessionBindingSchema),
};
export const SessionTransitionReadSchema = v.variant("kind", [
  v.strictObject({ ...readback, kind: v.literal("reuseSession") }),
  v.strictObject({ ...readback, kind: v.literal("resumeSession") }),
  v.strictObject({
    ...readback,
    kind: v.literal("changeModel"),
    effectiveAt: v.picklist(["now", "nextTurn"]),
  }),
  v.strictObject({
    ...readback,
    kind: v.literal("createWithHandoff"),
    transferId: ContextTransferIdSchema,
    deliveryId: DeliveryIdSchema,
    injection: v.picklist(["pending", "injected", "unknown", "failed"]),
  }),
]);
export const ForkTransferSchema = v.strictObject({
  transferId: ContextTransferIdSchema,
  source: HandoffSourceSchema,
  targetThreadId: ThreadIdSchema,
  firstRoundId: RoundIdSchema,
  state: v.picklist(["pending", "consumed"]),
});
export const sessionResults = [
  v.strictObject({
    kind: v.literal("sessionTransitionPreview"),
    preview: SessionTransitionPreviewSchema,
  }),
  v.strictObject({
    kind: v.literal("sessionSwitchAccepted"),
    threadId: ThreadIdSchema,
    operationId: CommandIdSchema,
  }),
  v.strictObject({ kind: v.literal("sessionTransition"), transition: SessionTransitionReadSchema }),
  v.strictObject({ kind: v.literal("threadForked"), fork: ForkTransferSchema }),
  v.strictObject({
    kind: v.literal("threadRelationships"),
    relationships: v.array(WorkRelationshipSchema),
    fork: v.nullable(ForkTransferSchema),
  }),
] as const;
export type HandoffEntry = v.InferOutput<typeof HandoffEntrySchema>;
export type SessionTransitionPreview = v.InferOutput<typeof SessionTransitionPreviewSchema>;
export type SessionTransitionRead = v.InferOutput<typeof SessionTransitionReadSchema>;
export type ForkTransfer = v.InferOutput<typeof ForkTransferSchema>;
export const sessionTransitionSchemas = {
  SessionTransitionPreview: SessionTransitionPreviewSchema,
  SessionTransitionRead: SessionTransitionReadSchema,
  ForkTransfer: ForkTransferSchema,
  HandoffEntry: HandoffEntrySchema,
};
