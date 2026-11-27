import type {
  DeviceRegistration,
  PendingRegistration,
  RegisteredDevice,
  DevicePairingResult,
  EnvironmentIdentity,
  EnvironmentId,
  RouteCatalog,
  OriginParser,
} from "@kraka/protocol";
import { canonicalHttpOrigin } from "@kraka/protocol";
import { sameEnvironmentIdentity } from "./session";
export type { DeviceRegistration, PendingRegistration, RegisteredDevice } from "@kraka/protocol";
export type CredentialDiscovery =
  | { kind: "available"; registration: DeviceRegistration }
  | { kind: "notRegistered" | "storageUnavailable" | "corruptRecord" }
  | { kind: "keyMissing" | "keyUnusable"; registration: DeviceRegistration };

type Completed = Extract<DevicePairingResult, { kind: "pairing.completed" }>;
/** Under the registrations/keys transaction, compare the row read now with the verified exchange on this connection. Keep the existing key handle. */
export function completeLocalPairing(
  current: DeviceRegistration | null,
  sent: PendingRegistration,
  verifiedEnvironment: EnvironmentIdentity,
  completed: Completed,
  now: number,
): { kind: "store" | "alreadyRegistered"; registration: RegisteredDevice } | { kind: "conflict" } {
  const { deviceKey, principal, permissions } = completed;
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !current ||
    !sent.claimId ||
    !sameEnvironmentIdentity(current.identity, verifiedEnvironment) ||
    !sameEnvironmentIdentity(sent.identity, verifiedEnvironment) ||
    completed.requestId !== sent.requestId ||
    current.keyId !== sent.keyId ||
    deviceKey.id !== sent.keyId ||
    current.deviceId !== sent.deviceId ||
    deviceKey.deviceId !== sent.deviceId ||
    principal.deviceId !== sent.deviceId ||
    current.publicKey !== sent.publicKey ||
    deviceKey.publicKey !== sent.publicKey ||
    current.target.projectId !== sent.target.projectId ||
    deviceKey.state.kind !== "usable" ||
    deviceKey.state.expiresAt <= now ||
    new Set(permissions).size !== permissions.length ||
    !permissions.every((right) => sent.requestedPermissions.includes(right))
  )
    return { kind: "conflict" };
  if (current.kind === "registered") {
    return current.principal.id === principal.id &&
      current.principal.deviceId === principal.deviceId &&
      current.principal.ownerId === principal.ownerId &&
      current.deviceKey.id === deviceKey.id &&
      current.deviceKey.deviceId === deviceKey.deviceId &&
      current.deviceKey.publicKey === deviceKey.publicKey &&
      current.deviceKey.state.kind === "usable" &&
      current.deviceKey.state.expiresAt === deviceKey.state.expiresAt &&
      current.permissions.length === permissions.length &&
      permissions.every((right) => current.permissions.includes(right))
      ? { kind: "alreadyRegistered", registration: current }
      : { kind: "conflict" };
  }
  if (
    current.inviteId !== sent.inviteId ||
    current.requestId !== sent.requestId ||
    current.claimId !== sent.claimId ||
    current.requestedPermissions.length !== sent.requestedPermissions.length ||
    !sent.requestedPermissions.every((right) => current.requestedPermissions.includes(right))
  )
    return { kind: "conflict" };
  return {
    kind: "store",
    registration: {
      kind: "registered",
      identity: current.identity,
      deviceId: deviceKey.deviceId,
      keyId: deviceKey.id,
      publicKey: deviceKey.publicKey,
      target: current.target,
      principal,
      deviceKey,
      permissions,
    },
  };
}
export type OriginPinInput = {
  origin: string;
  environmentId: EnvironmentId;
  verifiedIdentity: EnvironmentIdentity;
  confirmed: true;
};
/** Evaluate against the current origin-scoped row inside the commit transaction. */
export function planIdentityPin(
  currentOrigin: string,
  catalog: RouteCatalog,
  input: OriginPinInput,
  parser: OriginParser,
): { kind: "conflict" | "alreadyPinned" } | { kind: "commit"; catalog: RouteCatalog } {
  const origin = canonicalHttpOrigin(currentOrigin, parser);
  if (
    input.confirmed !== true ||
    !origin ||
    canonicalHttpOrigin(input.origin, parser) !== origin ||
    input.environmentId !== input.verifiedIdentity.id
  )
    return { kind: "conflict" };
  const entry = catalog.environments.find((row) => row.environmentId === input.environmentId);
  if (entry?.pinnedIdentity)
    return {
      kind: sameEnvironmentIdentity(entry.pinnedIdentity, input.verifiedIdentity)
        ? "alreadyPinned"
        : "conflict",
    };
  const pinned = {
    environmentId: input.environmentId,
    preferredRouteId: null,
    routes: [],
    ...entry,
    pinnedIdentity: input.verifiedIdentity,
  };
  return {
    kind: "commit",
    catalog: {
      ...catalog,
      environments: entry
        ? catalog.environments.map((row) => (row === entry ? pinned : row))
        : [...catalog.environments, pinned],
    },
  };
}
export interface IdentityPinStore {
  /** Compare and set in the selected origin's catalog transaction. Success is visible only after commit. */
  pin(input: OriginPinInput): Promise<"pinned" | "alreadyPinned" | "conflict" | "commitFailed">;
}
