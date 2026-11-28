import * as v from "valibot";
import { PermissionModeSchema } from "./access";
import {
  AdapterFamilySchema,
  ExecutorInstanceSnapshotSchema,
  InstancePermissionSchema,
} from "./executor-capabilities";
import { ChildModelSchema } from "./executor-tools";
import {
  ExecutorInstanceIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  AttemptIdSchema,
  RoundIdSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  NativeItemIdSchema,
} from "./ids";
import { RoundEndTimeEvidenceSchema } from "./lifecycle";
const text = v.pipe(v.string(), v.minLength(1));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const CredentialBindingSchema = v.strictObject({
  ownerId: PrincipalIdSchema,
  namespace: text,
  key: text,
  version: ObjectVersionSchema,
});
const variable = v.variant("kind", [
  v.strictObject({ kind: v.literal("literal"), value: v.string() }),
  v.strictObject({ kind: v.literal("secret"), binding: CredentialBindingSchema }),
]);
export const RegistrationInputSchema = v.strictObject({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  displayName: text,
  enabled: v.boolean(),
  driver: v.strictObject({
    executable: v.nullable(text),
    endpoint: v.nullable(text),
    configurationRoot: v.nullable(text),
    historyRoot: v.nullable(text),
    variables: v.record(v.pipe(text, v.regex(/^[A-Za-z_][A-Za-z0-9_]*$/)), variable),
  }),
  credential: v.nullable(CredentialBindingSchema),
  model: v.nullable(ChildModelSchema),
  permission: InstancePermissionSchema,
});
export const StoredRegistrationSchema = v.strictObject({
  ...RegistrationInputSchema.entries,
  version: ObjectVersionSchema,
});
const layer = v.strictObject({
  state: v.picklist(["yes", "no", "unknown"]),
  verifiedAt: v.nullable(time),
});
export const ReadinessSchema = v.strictObject({
  configured: layer,
  installed: layer,
  authenticated: layer,
  model: layer,
  operation: layer,
});
const option = v.union([
  v.strictObject({ kind: v.literal("enum"), values: v.array(text) }),
  v.strictObject({ kind: v.picklist(["boolean", "number", "string"]) }),
]);
export const ModelCatalogSchema = v.strictObject({
  checkedAt: time,
  models: v.array(
    v.strictObject({
      id: text,
      slug: text,
      displayName: text,
      isDefault: v.boolean(),
      options: v.record(text, option),
      unavailableReason: v.optional(text),
    }),
  ),
});
export const ExecutorRefreshedSchema = v.strictObject({
  kind: v.literal("executorRefreshed"),
  displayName: v.optional(text),
  enabled: v.optional(v.boolean()),
  instanceId: ExecutorInstanceIdSchema,
  configurationVersion: ObjectVersionSchema,
  snapshot: v.nullable(ExecutorInstanceSnapshotSchema),
  readiness: ReadinessSchema,
  authenticationReason: v.optional(v.nullable(text)),
  attemptedAt: v.optional(time),
  models: v.nullable(ModelCatalogSchema),
  binaryVersion: v.nullable(text),
  variables: v.array(v.strictObject({ name: text, kind: v.picklist(["secret", "literal"]) })),
  compatibilityAdvisory: v.nullable(v.picklist(["broken", "unsupported"])),
  versionAdvisory: v.nullable(text),
});
export type ExecutorRefreshed = v.InferOutput<typeof ExecutorRefreshedSchema>;
export const CodexEffectivePolicySchema = v.object({
  approvalsReviewer: v.literal("user"),
  approvalPolicy: v.union([
    v.picklist(["untrusted", "on-request"]),
    v.object({
      granular: v.object({
        rules: v.literal(false),
        sandbox_approval: v.literal(false),
        skill_approval: v.literal(false),
        request_permissions: v.literal(false),
        mcp_elicitations: v.literal(true),
      }),
    }),
  ]),
  sandbox: v.variant("type", [
    v.object({ type: v.literal("readOnly"), networkAccess: v.literal(false) }),
    v.object({
      type: v.literal("workspaceWrite"),
      writableRoots: v.array(v.string()),
      networkAccess: v.literal(false),
      excludeSlashTmp: v.literal(true),
      excludeTmpdirEnvVar: v.literal(true),
    }),
    v.object({ type: v.literal("dangerFullAccess") }),
  ]),
});
export type CodexEffectivePolicy = v.InferOutput<typeof CodexEffectivePolicySchema>;
const target = { roundId: RoundIdSchema, attemptId: AttemptIdSchema };
const item = { ...target, itemId: NativeItemIdSchema };
const root = { ...target, nativeRootTurnId: NativeRootTurnIdSchema };
export const ExecutorTurnUpdateSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("round.started"),
    ...root,
    nativeSessionId: NativeSessionIdSchema,
    startedAt: time,
    selectedMode: PermissionModeSchema,
    effectiveMode: PermissionModeSchema,
    effectivePolicy: v.optional(CodexEffectivePolicySchema),
    supportedModes: v.array(PermissionModeSchema),
    enforcement: v.literal("native"),
  }),
  v.strictObject({
    kind: v.literal("tool.started"),
    ...target,
    callId: NativeItemIdSchema,
    command: v.string(),
  }),
  v.strictObject({
    kind: v.literal("tool.output"),
    ...target,
    callId: NativeItemIdSchema,
    text: v.string(),
  }),
  v.strictObject({
    kind: v.literal("tool.ended"),
    ...target,
    callId: NativeItemIdSchema,
    output: v.nullable(v.string()),
    exitCode: v.nullable(v.number()),
  }),
  v.strictObject({
    kind: v.picklist(["assistant.delta", "assistant.final"]),
    ...item,
    text: v.string(),
  }),
  v.strictObject({
    kind: v.literal("round.ended"),
    ...root,
    endedAt: time,
    endTimeEvidence: RoundEndTimeEvidenceSchema,
    outcome: v.picklist(["completed", "stopped", "failed", "unknown", "superseded"]),
  }),
  v.strictObject({
    kind: v.literal("executor.failed"),
    ...target,
    reason: text,
    message: v.nullable(v.string()),
  }),
]);
export type ExecutorTurnUpdate = v.InferOutput<typeof ExecutorTurnUpdateSchema>;
