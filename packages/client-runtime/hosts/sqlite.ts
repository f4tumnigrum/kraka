import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { InputOutbox, type LocalStateMutation, type TransactionalState } from "../src";

export function openLocalInputs(path: string) {
  const db = new DatabaseSync(path);
  db.exec(
    "PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS local_state(key TEXT PRIMARY KEY, value BLOB NOT NULL)",
  );
  const get = db.prepare("SELECT value FROM local_state WHERE key=?");
  const put = db.prepare(
    "INSERT INTO local_state VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
  );
  const remove = db.prepare("DELETE FROM local_state WHERE key=?");
  function read(key: string) {
    const row = get.get(key);
    if (!row) return null;
    if (!(row.value instanceof Uint8Array)) throw Error("Invalid local record");
    return row.value;
  }
  function write(changes: readonly LocalStateMutation[]) {
    for (const { key, value } of changes) {
      if (value === null) remove.run(key);
      else put.run(key, value);
    }
  }
  const state: TransactionalState = {
    read: async (key) => read(key),
    async commit(changes) {
      await state.transact([], () => ({ result: undefined, writes: changes }));
    },
    async transact(keys, change) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const { result, writes } = change(keys.map(read));
        write(writes);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  const encoder = new TextEncoder(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const outbox = new InputOutbox({
    state,
    random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    now: Date.now,
    utf8: { encode: (s) => encoder.encode(s), decode: (b) => decoder.decode(b) },
    async withSender(key, work) {
      const suffix = createHash("sha256").update(key).digest("hex");
      const lease = new DatabaseSync(path + ".sender-" + suffix);
      try {
        try {
          lease.exec("BEGIN IMMEDIATE");
        } catch (e) {
          if (e instanceof Error && "errcode" in e && e.errcode === 5) return;
          if (e instanceof Error && "code" in e && e.code === "SQLITE_BUSY") return;
          throw e;
        }
        return await work();
      } finally {
        lease.close();
      }
    },
  });
  return { outbox, state, close: () => db.close() };
}
