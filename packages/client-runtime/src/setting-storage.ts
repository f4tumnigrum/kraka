import * as v from "valibot";
import {
  canonicalJson,
  DeviceSettingRowSchema,
  DeviceSettingWriteSchema,
  CommandIdSchema,
  ObjectVersionSchema,
  type CommandId,
  type DeviceId,
  type DeviceSettingRow,
  type DeviceSettingWrite,
} from "@kraka/protocol";
import type { DeviceSettingsStore } from "./settings";

/** The host commits one read/modify/write under a database write transaction. */
export interface SettingsStorage {
  update<T>(key: string, edit: (current: unknown) => { value: unknown; result: T }): Promise<T>;
}
const deviceFile = v.object({
  row: DeviceSettingRowSchema,
  receipts: v.array(
    v.object({
      commandId: CommandIdSchema,
      intent: v.string(),
      kind: v.picklist(["saved", "conflict"]),
      row: DeviceSettingRowSchema,
    }),
  ),
});
export function deviceSettingsStore(
  storage: SettingsStorage,
  deviceId: DeviceId,
): DeviceSettingsStore {
  const key = canonicalJson(["deviceSettings", deviceId]);
  const empty: DeviceSettingRow = v.parse(DeviceSettingRowSchema, {
    target: { kind: "device", deviceId },
    field: "fontSize",
    explicit: { kind: "absent" },
    version: "0",
  });
  function load(raw: unknown) {
    const file = raw === null ? { row: empty, receipts: [] } : v.parse(deviceFile, raw);
    if (file.row.target.deviceId !== deviceId) throw Error("Foreign device settings");
    return file;
  }
  return {
    read: () => storage.update(key, (raw) => ({ value: raw, result: load(raw).row })),
    write(commandId: CommandId, edit: DeviceSettingWrite) {
      v.parse(DeviceSettingWriteSchema, edit);
      if (edit.target.deviceId !== deviceId) throw Error("Foreign device setting");
      return storage.update(key, (raw) => {
        const { row, receipts } = load(raw);
        const intent = canonicalJson(edit);
        const prior = receipts.find((r) => r.commandId === commandId);
        if (prior) {
          if (prior.intent !== intent) throw Error("idConflict");
          return { value: raw, result: { kind: prior.kind, row: prior.row } };
        }
        const equal = canonicalJson(edit.change) === canonicalJson(row.explicit);
        const kind = equal || row.version === edit.baseVersion ? "saved" : "conflict";
        const saved =
          !equal && kind === "saved"
            ? {
                ...row,
                explicit: edit.change,
                version: v.parse(ObjectVersionSchema, String(BigInt(row.version) + 1n)),
              }
            : row;
        const receipt = { kind, row: saved } as const;
        return {
          value: { row: saved, receipts: [...receipts, { ...receipt, commandId, intent }] },
          result: receipt,
        };
      });
    },
  };
}

/** Bun and Electron main supply their native SQLite connection. */
export function sqliteSettingsStorage(db: {
  exec(sql: string): unknown;
  prepare(sql: string): { get(...args: string[]): unknown; run(...args: string[]): unknown };
}): SettingsStorage {
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS client_settings(key TEXT PRIMARY KEY,data TEXT NOT NULL)",
  );
  const read = db.prepare("SELECT data FROM client_settings WHERE key=?");
  const replace = db.prepare("INSERT OR REPLACE INTO client_settings VALUES(?,?)");
  return {
    async update<T>(
      key: string,
      edit: (raw: unknown) => { value: unknown; result: T },
    ): Promise<T> {
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = read.get(key);
        const raw: unknown = row
          ? JSON.parse(v.parse(v.object({ data: v.string() }), row).data)
          : null;
        const { value, result } = edit(raw);
        if (value !== raw) replace.run(key, JSON.stringify(value));
        db.exec("COMMIT");
        return result;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}
