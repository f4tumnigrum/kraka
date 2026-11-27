import * as v from "valibot";
import {
  AttemptIdSchema,
  CommandIdSchema,
  DeliveryIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  NativeRequestIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  TodoRequestIdSchema,
} from "./ids";
const text = v.pipe(v.string(), v.minLength(1));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const SecretPurposeSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("toolOnce"), tool: text }),
  v.strictObject({ kind: v.literal("commandFile"), tool: text, commandId: CommandIdSchema }),
]);
export const SecretTargetSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  todoRequestId: TodoRequestIdSchema,
  version: ObjectVersionSchema,
  attemptId: AttemptIdSchema,
  instanceId: ExecutorInstanceIdSchema,
  sessionId: NativeSessionIdSchema,
  requestId: NativeRequestIdSchema,
  purpose: SecretPurposeSchema,
});
/** Decode only inside the negotiated confidential handler. Public decisions reference receiptCommandId. */
export const PrivateSecretSubmissionSchema = v.strictObject({
  target: SecretTargetSchema,
  choice: v.variant("kind", [
    v.strictObject({ kind: v.literal("value"), value: v.string() }),
    v.strictObject({
      kind: v.literal("reference"),
      namespace: text,
      key: text,
      version: ObjectVersionSchema,
    }),
    v.strictObject({ kind: v.literal("declined") }),
  ]),
});
export const SecretReceiptSchema = v.strictObject({
  receiptCommandId: CommandIdSchema,
  ownerId: PrincipalIdSchema,
  target: SecretTargetSchema,
  savedAt: time,
  expiresAt: time,
  decision: v.picklist(["stored", "declined"]),
});
export const SecretFileGrantSchema = v.strictObject({
  receiptCommandId: CommandIdSchema,
  decisionCommandId: CommandIdSchema,
  ownerId: PrincipalIdSchema,
  deliveryId: DeliveryIdSchema,
  target: v.strictObject({
    ...SecretTargetSchema.entries,
    purpose: SecretPurposeSchema.options[1],
  }),
  expiresAt: time,
});
export type SecretReceipt = v.InferOutput<typeof SecretReceiptSchema>;
export type SecretFileGrant = v.InferOutput<typeof SecretFileGrantSchema>;
export type SecretTarget = v.InferOutput<typeof SecretTargetSchema>;
