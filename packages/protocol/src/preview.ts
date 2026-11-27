import * as v from "valibot";
import {
  AttemptIdSchema,
  BrowserProfileIdSchema,
  CommandIdSchema,
  ConnectionIdSchema,
  ContentTransferIdSchema,
  DeviceIdSchema,
  EnvironmentGenerationSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  HostInstanceIdSchema,
  PreviewNavigationIdSchema,
  PreviewSnapshotIdSchema,
  PreviewTabIdSchema,
  SubscriptionIdSchema,
  ThreadIdSchema,
} from "./ids";
import { DevelopmentUrlSchema } from "./ports";

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
function counter<const T extends string>(brand: T) {
  return v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/), v.brand(brand));
}
export const PreviewStateVersionSchema = counter("PreviewStateVersion");
export const PreviewControlEpochSchema = counter("PreviewControlEpoch");
export const PreviewFrameNumberSchema = counter("PreviewFrameNumber");
export const PREVIEW_LIMITS = {
  navigationTimeoutMs: 10_000,
  conditionWaitTimeoutMs: 10_000,
  frameAckTimeoutMs: 10_000,
  maxInFlightFrames: 1,
  maxPendingFrames: 1,
  unknownActionRetries: 0,
  idleHiddenTabMs: 1_800_000,
  maxProfiles: 24,
  maxProfileNameLength: 48,
} as const;

/** Stable loading-host identity also partitions browser profiles across environments and devices. */
export const PreviewHostSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("environmentBrowser") }),
  v.strictObject({ kind: v.literal("desktopBrowser"), deviceId: DeviceIdSchema }),
  v.strictObject({ kind: v.literal("deviceBrowser"), deviceId: DeviceIdSchema }),
]);
export const BrowserProfileIdentitySchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  host: PreviewHostSchema,
  profileId: BrowserProfileIdSchema,
});
export const BrowserProfileSchema = v.strictObject({
  ...BrowserProfileIdentitySchema.entries,
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(PREVIEW_LIMITS.maxProfileNameLength)),
  storage: v.variant("kind", [
    v.strictObject({
      kind: v.literal("persistent"),
      partition: v.pipe(v.string(), v.minLength(1)),
    }),
    v.strictObject({ kind: v.literal("ephemeral"), incognito: v.boolean() }),
  ]),
});
export const BrowserProfilesSchema = v.pipe(
  v.array(BrowserProfileSchema),
  v.maxLength(PREVIEW_LIMITS.maxProfiles),
);
export const BrowserProfileClearResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("cleared"), profile: BrowserProfileIdentitySchema }),
  v.strictObject({ kind: v.literal("unsupported"), profile: BrowserProfileIdentitySchema }),
  v.strictObject({
    kind: v.literal("failed"),
    profile: BrowserProfileIdentitySchema,
    reason: v.string(),
  }),
]);
export const PreviewAddressSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  environmentGeneration: EnvironmentGenerationSchema,
  threadId: ThreadIdSchema,
  host: PreviewHostSchema,
  hostGeneration: HostInstanceIdSchema,
  tabId: PreviewTabIdSchema,
});
export const PreviewControlSchema = v.strictObject({
  epoch: PreviewControlEpochSchema,
  owner: v.variant("kind", [
    v.strictObject({ kind: v.literal("unclaimed") }),
    v.strictObject({
      kind: v.literal("executor"),
      instanceId: ExecutorInstanceIdSchema,
      attemptId: AttemptIdSchema,
    }),
    v.strictObject({
      kind: v.literal("human"),
      deviceId: DeviceIdSchema,
      connectionId: ConnectionIdSchema,
    }),
  ]),
});
const navigation = { navigationId: PreviewNavigationIdSchema, requestedUrl: DevelopmentUrlSchema };
export const PreviewNavigationSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("idle") }),
  v.strictObject({ kind: v.literal("loading"), ...navigation, startedAt: time }),
  v.strictObject({
    kind: v.literal("success"),
    ...navigation,
    accessUrl: DevelopmentUrlSchema,
    sampledAt: time,
  }),
  v.strictObject({
    kind: v.literal("loadFailed"),
    ...navigation,
    sampledAt: time,
    reason: v.picklist(["timeout", "network", "tlsRejected", "hostUnavailable", "unsupported"]),
  }),
]);
export const PreviewTabSnapshotSchema = v.strictObject({
  address: PreviewAddressSchema,
  stateVersion: PreviewStateVersionSchema,
  title: v.string(),
  profile: BrowserProfileIdentitySchema,
  availability: v.picklist(["available", "hostDisconnected", "closed"]),
  visibility: v.picklist(["visible", "hidden"]),
  navigation: PreviewNavigationSchema,
  control: PreviewControlSchema,
});
export const PreviewElementReferenceSchema = v.strictObject({
  address: PreviewAddressSchema,
  navigationId: PreviewNavigationIdSchema,
  snapshotId: PreviewSnapshotIdSchema,
  controlEpoch: PreviewControlEpochSchema,
  elementId: v.pipe(v.string(), v.minLength(1)),
});
export const PreviewNavigateSchema = v.strictObject({
  commandId: CommandIdSchema,
  address: PreviewAddressSchema,
  controlEpoch: PreviewControlEpochSchema,
  navigationId: PreviewNavigationIdSchema,
  requestedUrl: DevelopmentUrlSchema,
  timeoutMs: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    PREVIEW_LIMITS.navigationTimeoutMs,
  ),
});
const condition = v.variant("kind", [
  v.strictObject({
    kind: v.literal("element"),
    selector: v.pipe(v.string(), v.minLength(1)),
    state: v.picklist(["attached", "visible", "hidden", "detached"]),
  }),
  v.strictObject({ kind: v.literal("text"), text: v.pipe(v.string(), v.minLength(1)) }),
  v.strictObject({ kind: v.literal("url"), url: DevelopmentUrlSchema }),
]);
/** Every condition must hold on the specified navigation before the deadline. */
export const PreviewWaitSchema = v.strictObject({
  commandId: CommandIdSchema,
  address: PreviewAddressSchema,
  navigationId: PreviewNavigationIdSchema,
  conditions: v.tupleWithRest([condition], condition),
  timeoutMs: v.optional(
    v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
    PREVIEW_LIMITS.conditionWaitTimeoutMs,
  ),
});
export const PreviewWaitResultSchema = v.strictObject({
  commandId: CommandIdSchema,
  address: PreviewAddressSchema,
  navigationId: PreviewNavigationIdSchema,
  sampledAt: time,
  outcome: v.picklist(["satisfied", "timedOut", "navigationChanged", "hostUnavailable"]),
});
export const PreviewFrameSchema = v.strictObject({
  address: PreviewAddressSchema,
  subscriptionId: SubscriptionIdSchema,
  frameNumber: PreviewFrameNumberSchema,
  sampledAt: time,
  content: ContentTransferIdSchema,
});
export const PreviewFrameAckSchema = v.strictObject({
  address: PreviewAddressSchema,
  subscriptionId: SubscriptionIdSchema,
  through: PreviewFrameNumberSchema,
});
export type PreviewAddress = v.InferOutput<typeof PreviewAddressSchema>;
export type PreviewControl = v.InferOutput<typeof PreviewControlSchema>;
export type PreviewTabSnapshot = v.InferOutput<typeof PreviewTabSnapshotSchema>;
export type PreviewElementReference = v.InferOutput<typeof PreviewElementReferenceSchema>;
export type PreviewWait = v.InferOutput<typeof PreviewWaitSchema>;
export type PreviewNavigate = v.InferOutput<typeof PreviewNavigateSchema>;
export type PreviewWaitResult = v.InferOutput<typeof PreviewWaitResultSchema>;
export type PreviewFrame = v.InferOutput<typeof PreviewFrameSchema>;
export type PreviewFrameAck = v.InferOutput<typeof PreviewFrameAckSchema>;
export type PreviewHost = v.InferOutput<typeof PreviewHostSchema>;
export type BrowserProfile = v.InferOutput<typeof BrowserProfileSchema>;
export type BrowserProfileIdentity = v.InferOutput<typeof BrowserProfileIdentitySchema>;
export type BrowserProfileClearResult = v.InferOutput<typeof BrowserProfileClearResultSchema>;

export function matchesPreviewAddress(expected: PreviewAddress, current: PreviewAddress): boolean {
  if (expected.host.kind !== current.host.kind) return false;
  if (
    "deviceId" in expected.host &&
    (!("deviceId" in current.host) || expected.host.deviceId !== current.host.deviceId)
  )
    return false;
  return (
    expected.environmentId === current.environmentId &&
    expected.environmentGeneration === current.environmentGeneration &&
    expected.threadId === current.threadId &&
    expected.hostGeneration === current.hostGeneration &&
    expected.tabId === current.tabId
  );
}

/** Recheck against the current snapshot at dispatch. Authorization and current ownership remain separate prerequisites. */
export function isCurrentPreviewElement(
  reference: PreviewElementReference,
  current: Pick<
    PreviewElementReference,
    "address" | "navigationId" | "snapshotId" | "controlEpoch"
  >,
): boolean {
  return (
    matchesPreviewAddress(reference.address, current.address) &&
    reference.navigationId === current.navigationId &&
    reference.snapshotId === current.snapshotId &&
    reference.controlEpoch === current.controlEpoch
  );
}

export const previewSchemas = {
  EnvironmentGeneration: EnvironmentGenerationSchema,
  PreviewTabId: PreviewTabIdSchema,
  PreviewNavigationId: PreviewNavigationIdSchema,
  PreviewSnapshotId: PreviewSnapshotIdSchema,
  BrowserProfileId: BrowserProfileIdSchema,
  PreviewStateVersion: PreviewStateVersionSchema,
  PreviewControlEpoch: PreviewControlEpochSchema,
  PreviewFrameNumber: PreviewFrameNumberSchema,
  PreviewHost: PreviewHostSchema,
  BrowserProfileIdentity: BrowserProfileIdentitySchema,
  BrowserProfile: BrowserProfileSchema,
  BrowserProfiles: BrowserProfilesSchema,
  BrowserProfileClearResult: BrowserProfileClearResultSchema,
  PreviewAddress: PreviewAddressSchema,
  PreviewControl: PreviewControlSchema,
  PreviewNavigation: PreviewNavigationSchema,
  PreviewTabSnapshot: PreviewTabSnapshotSchema,
  PreviewElementReference: PreviewElementReferenceSchema,
  PreviewNavigate: PreviewNavigateSchema,
  PreviewWait: PreviewWaitSchema,
  PreviewWaitResult: PreviewWaitResultSchema,
  PreviewFrame: PreviewFrameSchema,
  PreviewFrameAck: PreviewFrameAckSchema,
};
