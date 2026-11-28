import type {
  EnvironmentId,
  EnvironmentIdentity,
  RouteCatalog,
  DeviceKeyId,
  PairingChallenge,
  DevicePairingResult,
} from "@kraka/protocol";
import type {
  DeviceCredentialProvider,
  LocalStateStore,
  RandomSource,
  MonotonicClock,
  SessionHandle,
  PendingRegistration,
  IdentityPinStore,
} from "@kraka/client-runtime";
import { openSession } from "./session";

export const DEVICE_DATABASE = {
  name: "kraka-device-credentials",
  version: 1,
  registrations: "registrations",
  registrationKeyPath: "identity.id",
  keys: "keys",
  privateKeyPath: ["environmentId", "keyId"],
} as const;
/** Store only a nonextractable private ECDSA P-256 signing handle. Discovery checks its algorithm, usages and a local sign/verify challenge against the recorded public point. */
export type BrowserKeyRecord = {
  environmentId: EnvironmentId;
  keyId: DeviceKeyId;
  privateKey: CryptoKey & {
    readonly type: "private";
    readonly extractable: false;
    readonly algorithm: { readonly name: "ECDSA"; readonly namedCurve: "P-256" };
  };
};
export interface BrowserCredentials extends DeviceCredentialProvider {
  readonly origin: string;
  readonly environmentId: EnvironmentId;
  /** Atomically store the pending application and the matching private handle staged by createDeviceKey. */
  begin(
    pending: PendingRegistration,
  ): Promise<"stored" | "unchanged" | "conflict" | "commitFailed">;
  selectClaim(
    pending: PendingRegistration,
    challenge: PairingChallenge,
  ): Promise<"stored" | "unchanged" | "conflict" | "commitFailed">;
  complete(
    pending: PendingRegistration,
    identity: EnvironmentIdentity,
    reply: Extract<DevicePairingResult, { kind: "pairing.completed" }>,
  ): Promise<"stored" | "alreadyRegistered" | "conflict" | "commitFailed">;
}
export type SocketEvent =
  | { kind: "open" }
  | { kind: "message"; data: string | Uint8Array }
  | { kind: "error" }
  | { kind: "close"; code: number; reason: string };
export type BrowserSocketFactory = (
  sameOriginUrl: string,
  receive: (event: SocketEvent) => void,
) => { send(data: string | Uint8Array): void; close(code: number, reason?: string): void };
export interface BrowserPlatform {
  page(): { origin: string; secureContext: boolean; subtleAvailable: boolean };
  verify(publicKey: string, bytes: Uint8Array, signature: Uint8Array): Promise<boolean>;
  /** Origin-scoped IndexedDB byte records, committed atomically. CryptoKeys use the credentials database. */
  readonly state: LocalStateStore;
  readonly credentials: BrowserCredentials;
  readonly pins: IdentityPinStore;
  readonly random: RandomSource;
  readonly monotonic: MonotonicClock;
  utcMilliseconds(): number;
  readonly socketFactory: BrowserSocketFactory;
}
export interface BrowserSessionInput {
  pageOrigin: string;
  expectedIdentity: EnvironmentIdentity;
  routeCatalog: RouteCatalog;
  credentials: BrowserCredentials;
  socketFactory: BrowserSocketFactory;
}
/** Return the opening handle before discovery or dialing. Callers share the host implementation. */
export function openBrowserSession(input: BrowserSessionInput): SessionHandle {
  return openSession(input);
}
