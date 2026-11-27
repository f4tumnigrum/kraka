import {
  canonicalHttpOrigin,
  type OriginParser,
  type EnvironmentIdentity,
  type EnvironmentId,
  type RouteId,
  type RouteCatalogRead,
  type RouteCatalog,
  type SessionAuthorized,
  type SessionConfiguration,
  type ServerHello,
  type SignedRequest,
  type CommandReceipt,
  type CommandId,
  type RouteDiagnostic,
  type RouteFailureReason,
} from "@kraka/protocol";

export function sameEnvironmentIdentity(a: EnvironmentIdentity, b: EnvironmentIdentity): boolean {
  return a.id === b.id && a.publicKey === b.publicKey && a.keyVersion === b.keyVersion;
}
/** Both snapshots have passed catalog migration. Probe timestamps are live observations. */
export function sameRouteCatalog(a: RouteCatalog, b: RouteCatalog): boolean {
  return (
    a.formatVersion === b.formatVersion &&
    a.environments.length === b.environments.length &&
    a.environments.every((entry, i) => {
      const other = b.environments[i];
      if (
        !other ||
        entry.environmentId !== other.environmentId ||
        entry.preferredRouteId !== other.preferredRouteId ||
        entry.routes.length !== other.routes.length ||
        (entry.pinnedIdentity === null) !== (other.pinnedIdentity === null)
      )
        return false;
      if (
        entry.pinnedIdentity &&
        other.pinnedIdentity &&
        !sameEnvironmentIdentity(entry.pinnedIdentity, other.pinnedIdentity)
      )
        return false;
      return entry.routes.every((route, j) => {
        const match = other.routes[j];
        return (
          !!match &&
          route.id === match.id &&
          route.environmentId === match.environmentId &&
          route.kind === match.kind &&
          route.endpoint === match.endpoint &&
          route.sshProfileReference === match.sshProfileReference &&
          route.lastObservedSecureContext === match.lastObservedSecureContext
        );
      });
    })
  );
}
type PreDialFailure =
  | "originMismatch"
  | "insecureContext"
  | "invalidCatalog"
  | "unsupportedFormat"
  | "identityConflict"
  | "noSameOriginRoute"
  | "catalogChanged"
  | "pairingRequired";
export type BrowserSelection =
  | {
      kind: "selected";
      environmentId: EnvironmentId;
      routeId: RouteId;
      origin: string;
      generation: number;
    }
  | { kind: "unavailable"; reason: PreDialFailure; generation: number };
/** The catalog input is the latest committed catalog of the actual page origin. */
export function selectBrowserRoute(
  input: {
    actualOrigin: string;
    pageOrigin: string;
    secureContext: boolean;
    subtleAvailable: boolean;
    selectedEnvironmentId: EnvironmentId;
    expectedIdentity: EnvironmentIdentity;
    /** The host compares the supplied snapshot with this fresh origin-local read. */
    catalog: RouteCatalogRead;
    offeredCatalog: RouteCatalog;
    generation: number;
  },
  parser: OriginParser,
): BrowserSelection {
  const { catalog, generation } = input;
  const unavailable = (reason: PreDialFailure): BrowserSelection => ({
    kind: "unavailable",
    reason,
    generation,
  });
  const origin = canonicalHttpOrigin(input.actualOrigin, parser);
  if (!origin || origin !== canonicalHttpOrigin(input.pageOrigin, parser))
    return unavailable("originMismatch");
  const { hostname, protocol } = new parser(origin);
  const loopback =
    hostname === "localhost" ||
    hostname === "localhost." ||
    hostname.endsWith(".localhost") ||
    hostname === "[::1]" ||
    /^127\.\d+\.\d+\.\d+$/.test(hostname);
  if (!input.secureContext || !input.subtleAvailable || (protocol === "http:" && !loopback))
    return unavailable("insecureContext");
  if (catalog.kind !== "ready") return unavailable(catalog.kind);
  const entry = catalog.catalog.environments.find(
    (row) => row.environmentId === input.selectedEnvironmentId,
  );
  if (!entry?.pinnedIdentity) return unavailable("pairingRequired");
  if (!sameEnvironmentIdentity(entry.pinnedIdentity, input.expectedIdentity))
    return unavailable("identityConflict");
  if (!sameRouteCatalog(catalog.catalog, input.offeredCatalog))
    return unavailable("catalogChanged");
  const rows = entry.routes.filter(
    (route) => canonicalHttpOrigin(route.endpoint, parser) === origin,
  );
  const route = rows.find((route) => route.id === entry.preferredRouteId) ?? rows[0];
  return route
    ? {
        kind: "selected",
        environmentId: entry.environmentId,
        routeId: route.id,
        origin,
        generation,
      }
    : unavailable("noSameOriginRoute");
}
type MissingCredential =
  | "pairingRequired"
  | "notRegistered"
  | "keyMissing"
  | "keyUnusable"
  | "pendingExchange";
type VerifiedHello = Pick<ServerHello, "connectionId" | "identity"> & { routeId: RouteId };
export type SessionSnapshot = { generation: number } & (
  | { phase: "opening" | "closed" }
  | { phase: "unpaired"; reason: MissingCredential }
  | ({ phase: "helloVerified"; unpairedReason: MissingCredential | null } & VerifiedHello)
  | ({ phase: "authorizedAwaitingConfiguration"; authorization: SessionAuthorized } & VerifiedHello)
  | ({
      phase: "sendable";
      authorization: SessionAuthorized;
      configuration: SessionConfiguration;
    } & VerifiedHello)
  | {
      phase: "failed";
      failure:
        | { stage: "preDial"; reason: PreDialFailure }
        | { stage: "credentials"; reason: "storageUnavailable" | "corruptRecord" }
        | { stage: "route"; reason: RouteFailureReason; diagnostic?: RouteDiagnostic }
        | { stage: "route"; diagnostic: RouteDiagnostic }
        | { stage: "handshake" | "connection" | "configuration"; reason: string };
    }
);
type OnlineReadMethod = Extract<
  SignedRequest["method"],
  | "access.listSessions"
  | "access.listGrants"
  | "access.listChanges"
  | "device.pairing.listInvites"
  | "device.pairing.listApplications"
  | "settings.read"
  | "thread.readHistory"
  | "thread.readEarlierSettled"
  | "thread.inspectCheckout"
  | "thread.readChild"
  | "attention.read"
  | "git.readStatus"
  | "workspace.list"
  | "workspace.readFile"
  | "workspace.search"
  | "host.listDirectory"
  | "todo.readSecretReceipt"
  | "checkpoint.diff"
  | "checkpoint.readRollbackPart"
  | "forge.operation"
  | "forge.fileReading"
  | "forge.history"
>;
type ReadInput<T> = T extends { method: OnlineReadMethod; payload: unknown; commandId: CommandId }
  ? Pick<T, "commandId" | "method" | "payload">
  : never;
export type OnlineRead = ReadInput<SignedRequest>;
export type OnlineReadResult =
  | { kind: "receipt"; receipt: CommandReceipt }
  | {
      kind: "unavailable";
      commandId: CommandId;
      snapshot: Exclude<SessionSnapshot, { phase: "sendable" }>;
    }
  | { kind: "unconfirmed"; commandId: CommandId };
/** No read submitted before configuration installation consumes a sequence or enters the send queue. */
export function unavailableOnlineRead(
  snapshot: SessionSnapshot,
  commandId: CommandId,
): Extract<OnlineReadResult, { kind: "unavailable" }> | null {
  return snapshot.phase === "sendable" ? null : { kind: "unavailable", commandId, snapshot };
}
export interface SessionHandle {
  snapshot(): SessionSnapshot;
  /** Emit current state immediately, then transitions in order. */
  subscribe(listener: (snapshot: SessionSnapshot) => void): () => void;
  /** Check sendability at call time and again after signing. An unavailable read is never queued. */
  read(request: OnlineRead): Promise<OnlineReadResult>;
  close(): void;
}
