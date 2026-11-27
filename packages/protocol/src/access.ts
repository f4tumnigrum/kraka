import * as v from "valibot";
import {
  AccessGrantIdSchema,
  AttemptIdSchema,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
} from "./ids";

export const DEFAULT_DEVICE_PERMISSIONS = [
  "thread.view",
  "thread.send",
  "thread.reply",
  "term.view",
  "term.input",
  "workspace.change",
  "settings.change",
  "access.give",
  "owner.decide",
] as const;

export const PERMISSION_ITEMS = [...DEFAULT_DEVICE_PERMISSIONS, "environment.upgrade"] as const;
export const PermissionItemSchema = v.picklist(PERMISSION_ITEMS);
export type PermissionItem = (typeof PERMISSION_ITEMS)[number];

export const PermissionSetSchema = v.pipe(
  v.array(PermissionItemSchema),
  v.minLength(1),
  v.maxLength(PERMISSION_ITEMS.length),
  v.description(
    "Device pairing defaults to the nine ordinary permissions. Environment upgrades require an explicit grant.",
  ),
);

export const PermissionModeSchema = v.picklist(["ask", "edits", "open"]);
export type PermissionMode = v.InferOutput<typeof PermissionModeSchema>;

export const DevicePrincipalSchema = v.strictObject({
  kind: v.literal("device"),
  id: PrincipalIdSchema,
  deviceId: DeviceIdSchema,
  ownerId: PrincipalIdSchema,
});
export const ExecutorPrincipalSchema = v.strictObject({
  kind: v.literal("executor"),
  id: PrincipalIdSchema,
  executorInstanceId: ExecutorInstanceIdSchema,
  threadId: ThreadIdSchema,
  attemptId: AttemptIdSchema,
});
export type ExecutorPrincipal = v.InferOutput<typeof ExecutorPrincipalSchema>;
export const ActivePrincipalSchema = v.variant("kind", [
  DevicePrincipalSchema,
  ExecutorPrincipalSchema,
]);

/** Reserved identities may appear in history. Only the two active kinds can open a session. */
export const PrincipalSchema = v.variant("kind", [
  ...ActivePrincipalSchema.options,
  v.strictObject({
    kind: v.literal("scheduledJob"),
    id: PrincipalIdSchema,
    trigger: v.literal("timer"),
  }),
  v.strictObject({ kind: v.literal("helper"), id: PrincipalIdSchema }),
  v.strictObject({
    kind: v.literal("environmentLink"),
    id: PrincipalIdSchema,
    sourceEnvironmentId: EnvironmentIdSchema,
  }),
  v.strictObject({
    kind: v.literal("guest"),
    id: PrincipalIdSchema,
    sharedThreadId: ThreadIdSchema,
  }),
]);
export type Principal = v.InferOutput<typeof PrincipalSchema>;

/** A kind ceiling still requires a matching object grant. Executor tools stay in their own thread. */
export function withinPrincipalCeiling(
  principal: v.InferOutput<typeof ActivePrincipalSchema>,
  target: AuthorizationTarget,
  permission: PermissionItem,
): boolean {
  if (principal.kind === "device") return true;
  return (
    target.kind === "thread" &&
    target.threadId === principal.threadId &&
    (permission === "thread.view" ||
      permission === "thread.send" ||
      permission === "thread.reply" ||
      permission === "term.view" ||
      permission === "term.input" ||
      permission === "workspace.change")
  );
}

export const AuthorizationTargetSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("environment"), environmentId: EnvironmentIdSchema }),
  v.strictObject({ kind: v.literal("project"), projectId: ProjectIdSchema }),
  v.strictObject({ kind: v.literal("thread"), threadId: ThreadIdSchema }),
]);
export type AuthorizationTarget = v.InferOutput<typeof AuthorizationTargetSchema>;

export const GrantInheritanceSchema = v.picklist(["targetOnly", "children"]);

export const GrantAuthoritySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("device"),
    deviceId: DeviceIdSchema,
    principalId: PrincipalIdSchema,
  }),
  v.strictObject({ kind: v.literal("administrator"), policyId: v.string() }),
]);

/** A grant names its target, principal and right. Enforcement remains in the environment. */
export const PermissionGrantSchema = v.strictObject({
  id: AccessGrantIdSchema,
  target: AuthorizationTargetSchema,
  principalId: PrincipalIdSchema,
  permission: PermissionItemSchema,
  inheritance: GrantInheritanceSchema,
  modeCeiling: PermissionModeSchema,
  grantedBy: GrantAuthoritySchema,
});
export type PermissionGrant = v.InferOutput<typeof PermissionGrantSchema>;

/** Uncompressed SEC1 P-256 public point encoded as unpadded base64url. */
export const P256PublicKeySchema = v.pipe(
  v.string(),
  v.minLength(87),
  v.maxLength(87),
  v.regex(/^[A-Za-z0-9_-]+$/),
  v.description("Uncompressed SEC1 P-256 public point encoded as unpadded base64url."),
);
/** A fixed-width 64-byte P-256 ECDSA signature encoded as unpadded base64url. */
export const P256SignatureSchema = v.pipe(
  v.string(),
  v.minLength(86),
  v.maxLength(86),
  v.regex(/^[A-Za-z0-9_-]+$/),
  v.description("Fixed-width 64-byte P-256 ECDSA signature encoded as unpadded base64url."),
);

export const DeviceKeySchema = v.strictObject({
  id: DeviceKeyIdSchema,
  deviceId: DeviceIdSchema,
  publicKey: P256PublicKeySchema,
  state: v.variant("kind", [
    v.strictObject({
      kind: v.literal("usable"),
      expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
    v.strictObject({
      kind: v.literal("revoked"),
      revokedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    }),
  ]),
});
export type DeviceKey = v.InferOutput<typeof DeviceKeySchema>;

export const AuthorizationFailureSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("missingPermission"),
    permission: PermissionItemSchema,
    target: AuthorizationTargetSchema,
  }),
  v.strictObject({
    kind: v.literal("permissionLimited"),
    permission: PermissionItemSchema,
    target: AuthorizationTargetSchema,
    requestedMode: PermissionModeSchema,
    effectiveMode: PermissionModeSchema,
    limitedBy: GrantAuthoritySchema,
  }),
]);
export type AuthorizationFailure = v.InferOutput<typeof AuthorizationFailureSchema>;

export const AccessSchemas = {
  PermissionItem: PermissionItemSchema,
  PermissionSet: PermissionSetSchema,
  PermissionMode: PermissionModeSchema,
  Principal: PrincipalSchema,
  ActivePrincipal: ActivePrincipalSchema,
  DevicePrincipal: DevicePrincipalSchema,
  ExecutorPrincipal: ExecutorPrincipalSchema,
  AuthorizationTarget: AuthorizationTargetSchema,
  PermissionGrant: PermissionGrantSchema,
  DeviceKey: DeviceKeySchema,
  AuthorizationFailure: AuthorizationFailureSchema,
  P256PublicKey: P256PublicKeySchema,
  P256Signature: P256SignatureSchema,
} as const;

/** UTC deadlines are exclusive. Renewing a challenge does not extend an invitation. */
export const PAIRING_LIMITS = {
  inviteMs: 600_000,
  challengeMs: 30_000,
  deviceKeyMs: 2_592_000_000,
} as const;

export const SessionRejectionReasonSchema = v.picklist([
  "unknownKey",
  "revokedKey",
  "keyExpired",
  "invalidSignature",
  "challengeExpired",
  "unsupportedProtocolVersion",
]);
