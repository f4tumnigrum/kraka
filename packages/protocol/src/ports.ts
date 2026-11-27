import * as v from "valibot";
import {
  ConnectionIdSchema,
  DeviceIdSchema,
  EnvironmentGenerationSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  HostInstanceIdSchema,
  PortMappingIdSchema,
  PortServiceIdSchema,
  PortTicketIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
} from "./ids";
import { ProcessIdentitySchema, TerminalAddressSchema } from "./terminal";

const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const PortNumberSchema = v.pipe(
  v.number(),
  v.safeInteger(),
  v.minValue(1),
  v.maxValue(65_535),
);
export const DevelopmentUrlSchema = v.pipe(
  v.string(),
  v.url(),
  v.regex(/^[hH][tT][tT][pP][sS]?:\/\//),
);
export const PORT_LIMITS = {
  discoveryIntervalMs: 3_000,
  probeCacheMs: 15_000,
  maxConcurrentProbes: 16,
  ticketLifetimeMs: 60_000,
  maxTicketExchanges: 1,
  forwardHighWaterBytes: 1_048_576,
} as const;

/** A service identity expires when its listener, process start, or environment generation changes. */
export const PortServiceSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  environmentGeneration: EnvironmentGenerationSchema,
  serviceId: PortServiceIdSchema,
  port: PortNumberSchema,
  process: ProcessIdentitySchema,
});
export type PortService = v.InferOutput<typeof PortServiceSchema>;

export function matchesPortService(expected: PortService, current: PortService): boolean {
  return (
    expected.environmentId === current.environmentId &&
    expected.environmentGeneration === current.environmentGeneration &&
    expected.serviceId === current.serviceId &&
    expected.port === current.port &&
    expected.process.pid === current.process.pid &&
    expected.process.startedAt === current.process.startedAt
  );
}
export const PortOwnershipSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("verified"),
    projectId: ProjectIdSchema,
    threadId: ThreadIdSchema,
    serviceId: PortServiceIdSchema,
    process: ProcessIdentitySchema,
    registration: v.variant("kind", [
      v.strictObject({ kind: v.literal("terminal"), terminal: TerminalAddressSchema }),
      v.strictObject({ kind: v.literal("executor"), instanceId: ExecutorInstanceIdSchema }),
      v.strictObject({ kind: v.literal("developmentProcess") }),
    ]),
  }),
  v.strictObject({
    kind: v.literal("unverified"),
    reason: v.picklist(["processUnavailable", "registrationMissing", "processChanged"]),
  }),
]);
export type PortOwnership = v.InferOutput<typeof PortOwnershipSchema>;
/** Listening establishes an OS observation. Web verification requires a separate configured URL probe. */
export const PortObservationSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  environmentGeneration: EnvironmentGenerationSchema,
  port: PortNumberSchema,
  observedAt: time,
  kind: v.literal("listening"),
  ownership: PortOwnershipSchema,
  web: v.literal("unverified"),
});
export const PortUrlProbeResultSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  projectId: ProjectIdSchema,
  configuredUrl: DevelopmentUrlSchema,
  checkedAt: time,
  result: v.variant("kind", [
    v.strictObject({
      kind: v.literal("responded"),
      status: v.pipe(v.number(), v.safeInteger(), v.minValue(100), v.maxValue(599)),
    }),
    v.strictObject({
      kind: v.literal("failed"),
      reason: v.picklist(["timeout", "connectionRefused", "tlsRejected", "unavailable"]),
    }),
  ]),
});

/** Exchange once on this device connection. Recheck ownership before dialing the environment loopback service. */
export const PortAuthorizationTicketSchema = v.strictObject({
  id: PortTicketIdSchema,
  token: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{43}$/)),
  deviceId: DeviceIdSchema,
  connectionId: ConnectionIdSchema,
  service: PortServiceSchema,
  issuedAt: time,
  expiresAt: time,
});
export const DesktopPortMappingSchema = v.strictObject({
  id: PortMappingIdSchema,
  deviceId: DeviceIdSchema,
  desktopInstanceId: HostInstanceIdSchema,
  service: PortServiceSchema,
  localHost: v.literal("127.0.0.1"),
  localPort: PortNumberSchema,
  createdAt: time,
  state: v.variant("kind", [
    v.strictObject({ kind: v.literal("active") }),
    v.strictObject({
      kind: v.literal("closed"),
      reason: v.picklist(["requested", "revoked", "serviceChanged", "desktopExited"]),
    }),
  ]),
});
export type PortAuthorizationTicket = v.InferOutput<typeof PortAuthorizationTicketSchema>;
export type DesktopPortMapping = v.InferOutput<typeof DesktopPortMappingSchema>;
export type PortObservation = v.InferOutput<typeof PortObservationSchema>;
export type PortUrlProbeResult = v.InferOutput<typeof PortUrlProbeResultSchema>;

export const portSchemas = {
  PortServiceId: PortServiceIdSchema,
  PortTicketId: PortTicketIdSchema,
  PortMappingId: PortMappingIdSchema,
  PortNumber: PortNumberSchema,
  PortService: PortServiceSchema,
  PortOwnership: PortOwnershipSchema,
  PortObservation: PortObservationSchema,
  PortUrlProbeResult: PortUrlProbeResultSchema,
  PortAuthorizationTicket: PortAuthorizationTicketSchema,
  DesktopPortMapping: DesktopPortMappingSchema,
};
