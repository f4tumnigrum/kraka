import * as v from "valibot";
import {
  ChildTaskIdSchema,
  ChildResultTransferIdSchema,
  AttemptIdSchema,
  CommandIdSchema,
  DeliveryIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  TimelineItemIdSchema,
  NativeSessionIdSchema,
  TodoRequestIdSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  RoundIdSchema,
  ThreadIdSchema,
} from "./ids";
import { DirectoryBindingSchema } from "./workspace";
import { PermissionModeSchema } from "./access";
const text = v.pipe(v.string(), v.minLength(1));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const CheckoutResultSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("available"),
    binding: DirectoryBindingSchema,
    path: text,
    shared: v.boolean(),
  }),
  v.strictObject({ kind: v.literal("unavailable"), reason: text }),
]);
export const ChildModelSchema = v.strictObject({
  id: text,
  options: v.record(v.string(), v.union([v.string(), v.number(), v.boolean()])),
});
export const ChildLaunchSchema = v.strictObject({
  childCommandId: CommandIdSchema,
  projectId: ProjectIdSchema,
  instruction: text,
  checkout: v.picklist(["shared", "isolated"]),
  instanceId: v.optional(ExecutorInstanceIdSchema),
  model: v.optional(ChildModelSchema),
  requestedMode: v.optional(PermissionModeSchema),
});
export const ChildReceiptSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("accepted"),
    taskId: ChildTaskIdSchema,
    childCommandId: CommandIdSchema,
    threadId: ThreadIdSchema,
    roundId: RoundIdSchema,
  }),
  v.strictObject({ kind: v.literal("rejected"), childCommandId: CommandIdSchema, reason: text }),
]);
export const ChildStatusSchema = v.strictObject({
  taskId: ChildTaskIdSchema,
  childCommandId: CommandIdSchema,
  threadId: ThreadIdSchema,
  state: v.variant("kind", [
    v.strictObject({ kind: v.picklist(["queued", "working", "cancelled"]) }),
    v.strictObject({
      kind: v.literal("waitingApproval"),
      roundId: RoundIdSchema,
      requestId: TodoRequestIdSchema,
    }),
    v.strictObject({ kind: v.literal("completed"), result: v.string() }),
    v.strictObject({ kind: v.literal("failed"), reason: text }),
  ]),
});
export const ChildResultTransferSchema = v.strictObject({
  id: ChildResultTransferIdSchema,
  taskId: ChildTaskIdSchema,
  parentThreadId: ThreadIdSchema,
  parentRoundId: RoundIdSchema,
  childThreadId: ThreadIdSchema,
  childRoundId: RoundIdSchema,
  result: v.string(),
  version: ObjectVersionSchema,
  state: v.variant("kind", [
    v.strictObject({ kind: v.literal("pending") }),
    v.strictObject({
      kind: v.literal("returned"),
      parentMessageId: MessageIdSchema,
      returnedAt: time,
    }),
  ]),
});
export const DelegatedChildRecordSchema = v.strictObject({
  taskId: ChildTaskIdSchema,
  parentThreadId: ThreadIdSchema,
  parentRoundId: RoundIdSchema,
  childCommandId: CommandIdSchema,
  childThreadId: ThreadIdSchema,
  childRoundId: RoundIdSchema,
  instanceId: ExecutorInstanceIdSchema,
  model: ChildModelSchema,
  requestedMode: PermissionModeSchema,
  effectiveMode: PermissionModeSchema,
  returnTransferId: ChildResultTransferIdSchema,
  state: ChildStatusSchema.entries.state,
});
export type ChildResultTransfer = v.InferOutput<typeof ChildResultTransferSchema>;
export type DelegatedChildRecord = v.InferOutput<typeof DelegatedChildRecordSchema>;
const item = {
  environmentId: EnvironmentIdSchema,
  threadId: ThreadIdSchema,
  itemId: TimelineItemIdSchema,
};
export const AppSourceSchema = v.strictObject({
  ...item,
  instanceId: ExecutorInstanceIdSchema,
  sessionId: NativeSessionIdSchema,
  attemptId: AttemptIdSchema,
  generation: time,
  serviceId: text,
});
export const AppActionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("tool"), name: text, argumentsJson: v.string() }),
  v.strictObject({ kind: v.literal("resource"), uri: text }),
  v.strictObject({ kind: v.literal("message"), text }),
]);
export const AppCallbackSchema = v.strictObject({
  source: AppSourceSchema,
  action: AppActionSchema,
});
export const AppConfirmationSchema = v.strictObject({
  source: AppSourceSchema,
  commandId: CommandIdSchema,
  confirmedBy: PrincipalIdSchema,
  payloadDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  issuedAt: time,
  expiresAt: time,
});
export const AppCallbackResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("completed"), contentJson: v.string() }),
  v.strictObject({
    kind: v.picklist([
      "sessionStopped",
      "toolNotCallable",
      "resourceUnavailable",
      "confirmationRequired",
      "unknown",
    ]),
  }),
]);
export const AppNoteKeySchema = v.strictObject({
  targetThreadId: ThreadIdSchema,
  source: v.strictObject(item),
});
export const AppNoteSchema = v.strictObject({
  key: AppNoteKeySchema,
  version: ObjectVersionSchema,
  updatedAt: time,
  text: v.nullable(text),
});
const savedNote = v.strictObject({ ...AppNoteSchema.entries, text });
export const AppNoteReadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  deliveryId: DeliveryIdSchema,
  result: v.variant("kind", [
    v.strictObject({
      kind: v.literal("present"),
      notes: v.tupleWithRest([savedNote], savedNote),
    }),
    v.strictObject({ kind: v.literal("empty") }),
    v.strictObject({ kind: v.literal("failed"), reason: text }),
  ]),
});
export type AppSource = v.InferOutput<typeof AppSourceSchema>;
export type AppCallback = v.InferOutput<typeof AppCallbackSchema>;
export type AppConfirmation = v.InferOutput<typeof AppConfirmationSchema>;
export type AppNote = v.InferOutput<typeof AppNoteSchema>;
export type AppNoteRead = v.InferOutput<typeof AppNoteReadSchema>;
