import * as v from "valibot";
import {
  base64url,
  canonicalHttpOrigin,
  canonicalJson,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  DeviceRegistrationSchema,
  migrateRouteCatalog,
  type DeviceRegistration,
  type PendingRegistration,
  type PairingPending,
  type EnvironmentId,
  type DeviceKeyId,
  type RouteCatalog,
  type RouteCatalogRead,
} from "@kraka/protocol";
import {
  completeLocalPairing,
  planIdentityPin,
  type CredentialDiscovery,
  type IdentityPinStore,
  type TransactionalState,
  type CreatedDeviceKey,
} from "@kraka/client-runtime";
import {
  DEVICE_DATABASE,
  type BrowserPlatform,
  type BrowserCredentials,
  type BrowserKeyRecord,
} from "./index";

const records = "records";
export const catalogKey = "routeCatalog";
const utf8 = new TextEncoder();
const decode = new TextDecoder("utf-8", { fatal: true });
const p256 = { name: "ECDSA", namedCurve: "P-256" };
const algorithm = { name: "ECDSA", hash: "SHA-256" };
type ShowPending = (summary: PairingPending) => void;
export const pairingDisplays = new WeakMap<BrowserCredentials, ShowPending>();
export type BrowserHostOptions = {
  origin: string;
  environmentId: EnvironmentId;
  showPending?: ShowPending;
};

function open(db: "credentials" | "state"): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(
      db === "credentials" ? DEVICE_DATABASE.name : "kraka-browser-state",
      1,
    );
    req.onupgradeneeded = () => {
      if (db === "state") req.result.createObjectStore(records);
      else {
        req.result.createObjectStore(DEVICE_DATABASE.registrations, {
          keyPath: DEVICE_DATABASE.registrationKeyPath,
        });
        req.result.createObjectStore(DEVICE_DATABASE.keys, {
          keyPath: [...DEVICE_DATABASE.privateKeyPath],
        });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => {
      req.onsuccess = () => req.result.close();
      reject(new Error("Browser storage blocked"));
    };
  });
}
function read<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function transaction<T>(
  db: "credentials" | "state",
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const database = await open(db);
  try {
    const tx = database.transaction(
      db === "credentials" ? [DEVICE_DATABASE.keys, DEVICE_DATABASE.registrations] : records,
      mode,
    );
    const completed = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error ?? new Error("Browser transaction aborted"));
    });
    try {
      const [result] = await Promise.all([work(tx), completed]);
      return result;
    } catch (error) {
      try {
        tx.abort();
      } catch {
        /* Already settled. */
      }
      throw error;
    }
  } finally {
    database.close();
  }
}
function bytes(raw: unknown): Uint8Array | null {
  if (raw === undefined) return null;
  if (raw instanceof Uint8Array) return raw;
  throw Error("Invalid byte record");
}
export function decodeCatalog(raw: unknown): RouteCatalogRead {
  try {
    const data = bytes(raw);
    return migrateRouteCatalog(data ? JSON.parse(decode.decode(data)) : null);
  } catch {
    return { kind: "invalidCatalog" };
  }
}
async function catalogTransaction<T>(
  change: (loaded: RouteCatalogRead) => { result: T; replace?: RouteCatalog },
): Promise<T> {
  return transaction("state", "readwrite", async (tx) => {
    const store = tx.objectStore(records);
    const raw: unknown = await read(store.get(catalogKey));
    const loaded = decodeCatalog(raw);
    const next = change(loaded);
    const catalog =
      next.replace ?? (loaded.kind === "ready" && raw !== undefined ? loaded.catalog : null);
    if (catalog) {
      const json = JSON.stringify(catalog);
      if (!(raw instanceof Uint8Array) || decode.decode(raw) !== json)
        store.put(utf8.encode(json), catalogKey);
    }
    return next.result;
  });
}
export const readBrowserCatalog = () => catalogTransaction((loaded) => ({ result: loaded }));
export async function addBrowserRoute(
  identity: EnvironmentId,
  route: RouteCatalog["environments"][number]["routes"][number],
) {
  return catalogTransaction((loaded) => {
    if (loaded.kind !== "ready" || route.environmentId !== identity)
      throw Error("Invalid browser route");
    const home = loaded.catalog.environments.find((e) => e.environmentId === identity);
    if (!home?.pinnedIdentity) throw Error("Confirm the environment first");
    const existing = home.routes.find((r) => r.id === route.id);
    if (existing && (existing.endpoint !== route.endpoint || existing.kind !== route.kind))
      throw Error("Route ID already in use");
    const next = migrateRouteCatalog({
      ...loaded.catalog,
      environments: loaded.catalog.environments.map((e) =>
        e === home ? { ...home, routes: existing ? home.routes : [...home.routes, route] } : e,
      ),
    });
    if (next.kind !== "ready") throw Error("Invalid browser catalog");
    return { result: next.catalog, replace: next.catalog };
  });
}
export const state: TransactionalState = {
  transact: (keys, change) =>
    transaction("state", "readwrite", async (tx) => {
      const store = tx.objectStore(records);
      const { result, writes } = change(
        await Promise.all(keys.map(async (key) => bytes(await read(store.get(key))))),
      );
      for (const { key, value } of writes) {
        if (value === null) store.delete(key);
        else store.put(value, key);
      }
      return result;
    }),
  read: (key) =>
    transaction("state", "readonly", async (tx) =>
      bytes(await read(tx.objectStore(records).get(key))),
    ),
  commit: (mutations) =>
    transaction("state", "readwrite", async (tx) => {
      const store = tx.objectStore(records);
      for (const m of mutations) {
        if (m.value === null) store.delete(m.key);
        else store.put(m.value, m.key);
      }
    }),
};
export const browserPins: IdentityPinStore = {
  async pin(input) {
    try {
      return await catalogTransaction<"conflict" | "alreadyPinned" | "pinned">((loaded) => {
        if (loaded.kind !== "ready") return { result: "conflict" };
        const plan = planIdentityPin(location.origin, loaded.catalog, input, URL);
        return plan.kind === "commit"
          ? { result: "pinned", replace: plan.catalog }
          : { result: plan.kind };
      });
    } catch {
      return "commitFailed";
    }
  },
};
function signingKey(raw: unknown): raw is BrowserKeyRecord["privateKey"] {
  return (
    raw instanceof CryptoKey &&
    raw.type === "private" &&
    !raw.extractable &&
    raw.algorithm.name === "ECDSA" &&
    "namedCurve" in raw.algorithm &&
    raw.algorithm.namedCurve === "P-256" &&
    raw.usages.length === 1 &&
    raw.usages.includes("sign")
  );
}
export function decode64(s: string): Uint8Array<ArrayBuffer> {
  const raw = Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) =>
    c.charCodeAt(0),
  );
  if (base64url(raw) !== s) throw Error("Invalid base64url");
  return raw;
}
async function verify(
  publicKey: string,
  message: Uint8Array,
  signature: Uint8Array,
): Promise<boolean> {
  try {
    const raw = decode64(publicKey);
    if (raw.length !== 65 || raw[0] !== 4 || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey("raw", raw, p256, false, ["verify"]);
    return await crypto.subtle.verify(
      algorithm,
      key,
      new Uint8Array(signature),
      new Uint8Array(message),
    );
  } catch {
    return false;
  }
}
async function keyRecord(tx: IDBTransaction, env: EnvironmentId, keyId: DeviceKeyId) {
  const row: unknown = await read(tx.objectStore(DEVICE_DATABASE.keys).get([env, keyId]));
  if (row === undefined) return undefined;
  if (row && typeof row === "object" && "privateKey" in row && signingKey(row.privateKey))
    return row.privateKey;
  return null;
}
async function registration(tx: IDBTransaction, environmentId: EnvironmentId) {
  const raw: unknown = await read(tx.objectStore(DEVICE_DATABASE.registrations).get(environmentId));
  return raw === undefined ? null : v.parse(DeviceRegistrationSchema, raw);
}
type WriteDecision = "stored" | "unchanged" | "alreadyRegistered" | "conflict";
export function createBrowserCredentials({
  origin,
  environmentId,
  showPending,
}: BrowserHostOptions): BrowserCredentials {
  if (!canonicalHttpOrigin(origin, URL) || canonicalHttpOrigin(origin, URL) !== location.origin)
    throw Error("Credentials belong to another origin");
  const staged = new Map<
    DeviceKeyId,
    { pub: CreatedDeviceKey; privateKey: BrowserKeyRecord["privateKey"] }
  >();
  async function write<T extends WriteDecision>(
    pending: PendingRegistration,
    update: (
      tx: IDBTransaction,
      current: DeviceRegistration | null,
      key: CryptoKey | null | undefined,
    ) => T,
  ) {
    if (pending.identity.id !== environmentId || !v.is(DeviceRegistrationSchema, pending))
      return "conflict";
    try {
      return await transaction("credentials", "readwrite", async (tx) => {
        const [current, key] = await Promise.all([
          registration(tx, environmentId),
          keyRecord(tx, environmentId, pending.keyId),
        ]);
        return update(tx, current, key);
      });
    } catch {
      return "commitFailed";
    }
  }
  const credentials: BrowserCredentials = {
    origin,
    environmentId,
    async createDeviceKey() {
      const pair = await crypto.subtle.generateKey(p256, false, ["sign", "verify"]);
      if (!signingKey(pair.privateKey)) throw Error("Unusable signing key");
      const pub = {
        deviceId: v.parse(DeviceIdSchema, crypto.randomUUID()),
        keyId: v.parse(DeviceKeyIdSchema, crypto.randomUUID()),
        publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      };
      staged.set(pub.keyId, { pub, privateKey: pair.privateKey });
      return pub;
    },
    async begin(pending) {
      const result = await write(pending, (tx, current, key) => {
        if (current || key !== undefined)
          return current && key && canonicalJson(current) === canonicalJson(pending)
            ? "unchanged"
            : "conflict";
        const stagedKey = staged.get(pending.keyId);
        if (
          !stagedKey ||
          pending.claimId !== null ||
          stagedKey.pub.deviceId !== pending.deviceId ||
          stagedKey.pub.publicKey !== pending.publicKey
        )
          return "conflict";
        tx.objectStore(DEVICE_DATABASE.keys).add({
          environmentId,
          keyId: pending.keyId,
          privateKey: stagedKey.privateKey,
        } satisfies BrowserKeyRecord);
        tx.objectStore(DEVICE_DATABASE.registrations).add(pending);
        return "stored";
      });
      if (result === "stored" || result === "unchanged") staged.delete(pending.keyId);
      return result;
    },
    selectClaim(pending, challenge) {
      return write(pending, (tx, current, key) => {
        if (
          !key ||
          current?.kind !== "pendingExchange" ||
          challenge.requestId !== pending.requestId ||
          (pending.claimId !== null && pending.claimId !== challenge.claimId) ||
          (current.claimId !== null && current.claimId !== challenge.claimId) ||
          canonicalJson({ ...current, claimId: null }) !==
            canonicalJson({ ...pending, claimId: null })
        )
          return "conflict";
        if (current.claimId === challenge.claimId) return "unchanged";
        tx.objectStore(DEVICE_DATABASE.registrations).put({
          ...current,
          claimId: challenge.claimId,
        });
        return "stored";
      });
    },
    complete(pending, identity, reply) {
      return write(pending, (tx, current, key) => {
        if (!key) return "conflict";
        const plan = completeLocalPairing(current, pending, identity, reply, Date.now());
        if (plan.kind !== "store") return plan.kind;
        tx.objectStore(DEVICE_DATABASE.registrations).put(plan.registration);
        return "stored";
      });
    },
    async discover(id): Promise<CredentialDiscovery> {
      if (id !== environmentId) return { kind: "notRegistered" };
      try {
        const result = await transaction("credentials", "readonly", async (tx) => {
          const raw: unknown = await read(tx.objectStore(DEVICE_DATABASE.registrations).get(id));
          if (raw === undefined) return { kind: "notRegistered" } as const;
          const parsed = v.safeParse(DeviceRegistrationSchema, raw);
          if (!parsed.success || parsed.output.identity.id !== id)
            return { kind: "corruptRecord" } as const;
          const registration = parsed.output;
          const key = await keyRecord(tx, id, registration.keyId);
          return { kind: "row", key, registration } as const;
        });
        if (result.kind !== "row") return result;
        const { registration, key } = result;
        if (key === undefined) return { kind: "keyMissing", registration };
        if (key) {
          try {
            const challenge = crypto.getRandomValues(new Uint8Array(32));
            const signature = await crypto.subtle.sign(algorithm, key, challenge);
            if (await verify(registration.publicKey, challenge, new Uint8Array(signature)))
              return { kind: "available", registration };
          } catch {
            /* Unusable handle. */
          }
        }
        return { kind: "keyUnusable", registration };
      } catch {
        return { kind: "storageUnavailable" };
      }
    },
    async sign(keyId, message) {
      const key = await transaction("credentials", "readonly", (tx) =>
        keyRecord(tx, environmentId, keyId),
      );
      if (!key) throw Error("Signing key unavailable");
      return base64url(
        new Uint8Array(await crypto.subtle.sign(algorithm, key, new Uint8Array(message))),
      );
    },
    async removeDeviceKey(keyId) {
      await transaction("credentials", "readwrite", async (tx) => {
        tx.objectStore(DEVICE_DATABASE.keys).delete([environmentId, keyId]);
      });
      staged.delete(keyId);
    },
  };
  if (showPending) pairingDisplays.set(credentials, showPending);
  return credentials;
}
export function createBrowserPlatform(
  credentials: BrowserCredentials,
  socketFactory: BrowserPlatform["socketFactory"],
): BrowserPlatform {
  return {
    page: () => ({
      origin: location.origin,
      secureContext: window.isSecureContext,
      subtleAvailable: !!globalThis.crypto?.subtle,
    }),
    verify,
    state,
    credentials,
    pins: browserPins,
    random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    monotonic: { nowMilliseconds: () => performance.now() },
    utcMilliseconds: Date.now,
    socketFactory,
  };
}
