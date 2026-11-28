import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { lstatSync } from "node:fs";
import * as v from "valibot";
import {
  canonicalJson,
  DeviceRegistrationSchema,
  migrateRouteCatalog,
  type Route,
  ReminderRecordSchema,
  type EnvironmentId,
  type ThreadId,
} from "@kraka/protocol";
import { signP256, verifyP256 } from "@kraka/protocol/web-crypto";
import {
  emptyThreadCache,
  sameEnvironmentIdentity,
  deviceSettingsStore,
  sqliteSettingsStorage,
  claimReminder,
  reminderKeyId,
  updateReminder,
  type ReminderLedger,
  type ThreadCache,
  type ThreadCacheStore,
} from "@kraka/client-runtime";
import { openLocalInputs } from "@kraka/client-runtime/sqlite";

export async function openDesktopProfile(
  directory: string,
  environmentId: EnvironmentId,
  threadId: ThreadId,
) {
  const file = join(directory, "device.sqlite"),
    stat = lstatSync(file);
  if (
    !stat.isFile() ||
    stat.nlink !== 1 ||
    (process.platform !== "win32" &&
      (stat.uid !== process.geteuid?.() || (stat.mode & 0o077) !== 0))
  )
    throw Error("Expected private desktop credential file");
  const db = new DatabaseSync(file, { readOnly: true });
  let key: CryptoKey;
  const registration = await (async () => {
    try {
      const row = db
        .prepare("SELECT device,key_id,public,secret FROM local_device WHERE id=1")
        .get();
      const record = db.prepare("SELECT body FROM registrations WHERE env=?").get(environmentId);
      if (typeof record?.body !== "string" || typeof row?.secret !== "string")
        throw Error("Desktop device registration missing");
      const r = v.parse(DeviceRegistrationSchema, JSON.parse(record.body));
      if (
        r.kind !== "registered" ||
        r.identity.id !== environmentId ||
        r.deviceId !== row.device ||
        r.keyId !== row.key_id ||
        r.publicKey !== row.public ||
        r.deviceKey.publicKey !== r.publicKey ||
        r.principal.deviceId !== r.deviceId ||
        r.deviceKey.id !== r.keyId ||
        r.deviceKey.deviceId !== r.deviceId
      )
        throw Error("Desktop registration mismatch");
      key = await crypto.subtle.importKey(
        "pkcs8",
        Buffer.from(row.secret, "base64url"),
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      const nonce = crypto.randomUUID();
      if (!(await verifyP256(r.publicKey, nonce, await signP256(key, nonce))))
        throw Error("Desktop key mismatch");
      return r;
    } finally {
      db.close();
    }
  })();
  const local = openLocalInputs(join(directory, "state.sqlite"));
  const settingsDb = new DatabaseSync(join(directory, "settings.sqlite"));
  const deviceSettings = deviceSettingsStore(
    sqliteSettingsStorage(settingsDb),
    registration.deviceId,
  );
  const namespace = canonicalJson(["thread", environmentId, registration.principal.id, threadId]);
  const parse = (bytes: Uint8Array | null | undefined): ThreadCache =>
    bytes ? JSON.parse(new TextDecoder().decode(bytes)) : emptyThreadCache();
  let cache = parse(await local.state.read(namespace));
  const store: ThreadCacheStore & { read(): ThreadCache } = {
    read: () => cache,
    async transact(edit) {
      const saved = await local.state.transact([namespace], ([bytes]) => {
        const old = parse(bytes),
          value = edit(old);
        return {
          result: value,
          writes:
            old === value.next
              ? []
              : [{ key: namespace, value: new TextEncoder().encode(JSON.stringify(value.next)) }],
        };
      });
      cache = saved.next;
      return saved.result;
    },
  };
  const reminders: ReminderLedger = {
    claim(hint, visible) {
      const name = "reminder/" + reminderKeyId(hint.key);
      return local.state.transact([name], ([data]) => {
        const old = data
          ? v.parse(ReminderRecordSchema, JSON.parse(new TextDecoder().decode(data)))
          : null;
        const claim = claimReminder(registration.deviceId, hint, visible, old);
        return {
          result: claim,
          writes: old
            ? []
            : [{ key: name, value: new TextEncoder().encode(JSON.stringify(claim.record)) }],
        };
      });
    },
    async update(key, event) {
      const name = "reminder/" + reminderKeyId(key);
      await local.state.transact([name], ([data]) => {
        const old = v.parse(
          ReminderRecordSchema,
          JSON.parse(new TextDecoder().decode(data ?? undefined)),
        );
        const next = updateReminder(old, event);
        return {
          result: undefined,
          writes: [{ key: name, value: new TextEncoder().encode(JSON.stringify(next)) }],
        };
      });
    },
  };
  const catalogKey = "routeCatalog";
  function catalog(data: Uint8Array | null | undefined) {
    const result = migrateRouteCatalog(data ? JSON.parse(new TextDecoder().decode(data)) : null);
    if (result.kind !== "ready") throw Error("Desktop route catalog unavailable");
    return result.catalog;
  }
  return {
    registration,
    deviceSettings,
    reminders,
    async saveLocalRoute(route: Route) {
      await local.state.transact([catalogKey], ([data]) => {
        const current = catalog(data);
        const old = current.environments.find((e) => e.environmentId === environmentId);
        if (
          old?.pinnedIdentity &&
          !sameEnvironmentIdentity(registration.identity, old.pinnedIdentity)
        )
          throw Error("Conflicting environment pin");
        const entry = {
          environmentId,
          pinnedIdentity: registration.identity,
          preferredRouteId: old?.preferredRouteId ?? route.id,
          routes: [route, ...(old?.routes ?? []).filter((r) => r.id !== route.id)],
        };
        const next = {
          ...current,
          environments: [
            ...current.environments.filter((e) => e.environmentId !== environmentId),
            entry,
          ],
        };
        return {
          result: undefined,
          writes: [{ key: catalogKey, value: new TextEncoder().encode(JSON.stringify(next)) }],
        };
      });
    },
    async route(id: Route["id"]) {
      const entry = catalog(await local.state.read(catalogKey)).environments.find(
        (e) => e.environmentId === environmentId,
      );
      if (
        !entry?.pinnedIdentity ||
        !sameEnvironmentIdentity(registration.identity, entry.pinnedIdentity)
      )
        return null;
      return entry.routes.find((r) => r.id === id && r.environmentId === environmentId) ?? null;
    },
    sign: (text: string) => signP256(key, text),
    store,
    state: local.state,
    outbox: local.outbox,
    close() {
      try {
        local.close();
      } finally {
        settingsDb.close();
      }
    },
  };
}
