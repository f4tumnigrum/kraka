import * as v from "valibot";
import { P256PublicKeySchema, SessionRejectionReasonSchema } from "./access";
import { EnvironmentIdSchema, HostInstanceIdSchema, RouteIdSchema } from "./ids";

import type { OriginParser } from "./origins";

// Both browser and Bun hosts provide WHATWG URL. The client core has no DOM types.
declare const URL: OriginParser;

export const BUSINESS_WEBSOCKET_PATH = "/ws";
/** Host status requires separate process-exit evidence. */
export const BUSINESS_CLOSE_CODES = {
  normal: 1000,
  cancelledAttempt: 4000,
  revoked: 4001,
} as const;
export const ROUTE_LIMITS = {
  preferredHeadStartMs: 500,
  maxProbesPerRoute: 1,
  maxConcurrentProbes: 4,
  identityTimeoutMs: 2_500,
  authenticationTimeoutMs: 15_000,
  configurationIdleTimeoutMs: 75_000,
  probeIntervalMs: 5_000,
  noAnswerTimeoutMs: 15_000,
  foregroundProbeTimeoutMs: 3_000,
  firstReconnectMinimumMs: 250,
  firstReconnectMaximumMs: 4_250,
  reconnectInitialCapMs: 4_000,
  reconnectMaximumCapMs: 300_000,
  reconnectCapMultiplier: 2,
  reconnectMinimumFraction: 0.5,
  stableResetMs: 30_000,
  sshBindAttempts: 3,
  sshReadyTimeoutMs: 15_000,
} as const;

export const RouteKindSchema = v.picklist(["local", "lan", "ssh", "userMesh"]);
export type RouteKind = v.InferOutput<typeof RouteKindSchema>;

const ordinaryFailure = v.picklist([
  "noResponse",
  "connectionRefused",
  "authorizationRejected",
  "insecureContext",
  "revoked",
]);
export const RouteFailureReasonSchema = v.union([
  ordinaryFailure,
  v.strictObject({
    kind: v.literal("authenticationRejected"),
    reason: SessionRejectionReasonSchema,
  }),
  v.strictObject({
    kind: v.literal("wrongEnvironment"),
    actualEnvironmentId: EnvironmentIdSchema,
  }),
]);
export type RouteFailureReason = v.InferOutput<typeof RouteFailureReasonSchema>;

export const RouteStatusSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("untested") }),
  v.strictObject({
    kind: v.literal("probing"),
    startedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.strictObject({
    kind: v.literal("reachable"),
    checkedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.strictObject({
    kind: v.literal("unavailable"),
    checkedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
    reason: RouteFailureReasonSchema,
  }),
]);
export type RouteStatus = v.InferOutput<typeof RouteStatusSchema>;

/** Route rows contain endpoints and results, never credentials or private keys. */
export const RouteSchema = v.strictObject({
  id: RouteIdSchema,
  environmentId: EnvironmentIdSchema,
  kind: RouteKindSchema,
  endpoint: v.pipe(
    v.string(),
    v.maxLength(2048),
    v.url(),
    v.regex(
      /^[hH][tT][tT][pP][sS]?:\/\/(?:[a-zA-Z0-9.-]+|\[[0-9a-fA-F:.]+\])(?::0*(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5]))?\/?$/,
    ),
    v.description(
      "HTTP origin or HTTPS origin without credentials. Browsers require HTTPS except on loopback, including local SSH forwards.",
    ),
  ),
  lastObservedSecureContext: v.optional(v.boolean()),
  status: RouteStatusSchema,
});
export type Route = v.InferOutput<typeof RouteSchema>;

export const EnvironmentIdentitySchema = v.strictObject({
  id: EnvironmentIdSchema,
  publicKey: P256PublicKeySchema,
  keyVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
});
export type EnvironmentIdentity = v.InferOutput<typeof EnvironmentIdentitySchema>;

export const ROUTE_CATALOG_FORMAT = 1;
const catalogRoute = v.strictObject({
  ...RouteSchema.entries,
  sshProfileReference: v.optional(v.pipe(v.string(), v.minLength(1))),
});
/** Array order is manual priority. A null pinned identity requires independent verification before authentication. */
export const RouteCatalogSchema = v.strictObject({
  formatVersion: v.literal(ROUTE_CATALOG_FORMAT),
  environments: v.array(
    v.strictObject({
      environmentId: EnvironmentIdSchema,
      pinnedIdentity: v.nullable(EnvironmentIdentitySchema),
      preferredRouteId: v.nullable(RouteIdSchema),
      routes: v.array(catalogRoute),
    }),
  ),
});
const oldRoute = v.strictObject({
  ...v.omit(catalogRoute, ["lastObservedSecureContext"]).entries,
  secureContext: v.boolean(),
});
const oldCatalog = v.strictObject({
  ...RouteCatalogSchema.entries,
  environments: v.array(
    v.strictObject({
      ...RouteCatalogSchema.entries.environments.item.entries,
      routes: v.array(oldRoute),
    }),
  ),
});
function migrateOldRoute({ secureContext, ...route }: v.InferOutput<typeof oldRoute>) {
  return { ...route, lastObservedSecureContext: secureContext };
}
export type RouteCatalog = v.InferOutput<typeof RouteCatalogSchema>;
export type RouteCatalogRead =
  | { kind: "ready"; catalog: RouteCatalog }
  | { kind: "unsupportedFormat"; formatVersion: number }
  | { kind: "invalidCatalog" };

/** Validate and prepare one atomic replacement. The caller retains the old bytes until commit succeeds. Every load resets live reachability. */
export function migrateRouteCatalog(raw: unknown): RouteCatalogRead {
  if (raw === null) return { kind: "ready", catalog: { formatVersion: 1, environments: [] } };
  if (
    typeof raw === "object" &&
    !Array.isArray(raw) &&
    "formatVersion" in raw &&
    typeof raw.formatVersion === "number" &&
    raw.formatVersion > ROUTE_CATALOG_FORMAT
  ) {
    return { kind: "unsupportedFormat", formatVersion: raw.formatVersion };
  }
  let catalog: RouteCatalog;
  if (Array.isArray(raw)) {
    const legacy = v.safeParse(v.array(v.union([RouteSchema, oldRoute])), raw);
    if (!legacy.success) return { kind: "invalidCatalog" };
    const environments: RouteCatalog["environments"] = [];
    for (const route of legacy.output) {
      let entry = environments.find((item) => item.environmentId === route.environmentId);
      if (!entry) {
        entry = {
          environmentId: route.environmentId,
          pinnedIdentity: null,
          preferredRouteId: null,
          routes: [],
        };
        environments.push(entry);
      }
      entry.routes.push("secureContext" in route ? migrateOldRoute(route) : route);
    }
    catalog = { formatVersion: 1, environments };
  } else {
    const parsed = v.safeParse(RouteCatalogSchema, raw);
    if (parsed.success) catalog = parsed.output;
    else {
      const legacy = v.safeParse(oldCatalog, raw);
      if (!legacy.success) return { kind: "invalidCatalog" };
      catalog = {
        ...legacy.output,
        environments: legacy.output.environments.map((entry) => ({
          ...entry,
          routes: entry.routes.map(migrateOldRoute),
        })),
      };
    }
  }
  const environmentIds = new Set<string>();
  const routeIds = new Set<string>();
  for (const entry of catalog.environments) {
    if (
      environmentIds.has(entry.environmentId) ||
      (entry.pinnedIdentity !== null && entry.pinnedIdentity.id !== entry.environmentId) ||
      (entry.preferredRouteId !== null &&
        !entry.routes.some((route) => route.id === entry.preferredRouteId))
    ) {
      return { kind: "invalidCatalog" };
    }
    environmentIds.add(entry.environmentId);
    for (const route of entry.routes) {
      if (route.environmentId !== entry.environmentId || routeIds.has(route.id))
        return { kind: "invalidCatalog" };
      routeIds.add(route.id);
    }
  }
  for (const entry of catalog.environments) {
    const origins = new Map<string, Route["id"]>();
    const rows: typeof entry.routes = [];
    for (const route of entry.routes) {
      const endpoint = new URL(route.endpoint).origin;
      const path = JSON.stringify([route.kind, endpoint, route.sshProfileReference]);
      const first = origins.get(path);
      if (first !== undefined) {
        if (entry.preferredRouteId === route.id) entry.preferredRouteId = first;
        continue;
      }
      origins.set(path, route.id);
      rows.push({ ...route, endpoint, status: { kind: "untested" } });
    }
    entry.routes = rows;
  }
  return { kind: "ready", catalog };
}

export const HostStatusSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("running"),
    instanceId: HostInstanceIdSchema,
    observedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.strictObject({
    kind: v.literal("stopped"),
    instanceId: HostInstanceIdSchema,
    exitedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  }),
  v.strictObject({
    kind: v.literal("unknown"),
    lastObservedAt: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  }),
]);
export type HostStatus = v.InferOutput<typeof HostStatusSchema>;

/** Evidence refers to the current host instance. Without either observation the host is unknown. */
export function describeHost(
  running: Extract<HostStatus, { kind: "running" }> | null,
  exit: Extract<HostStatus, { kind: "stopped" }> | null,
): HostStatus {
  return running ?? exit ?? { kind: "unknown", lastObservedAt: null };
}

export const RouteSchemas = {
  RouteKind: RouteKindSchema,
  RouteFailureReason: RouteFailureReasonSchema,
  RouteStatus: RouteStatusSchema,
  Route: RouteSchema,
  EnvironmentIdentity: EnvironmentIdentitySchema,
  RouteCatalog: RouteCatalogSchema,
  HostStatus: HostStatusSchema,
} as const;
