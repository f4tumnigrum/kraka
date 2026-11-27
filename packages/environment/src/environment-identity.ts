import { Database } from "bun:sqlite";
import { existsSync, readFileSync, writeFileSync, linkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { EnvironmentIdSchema, type EnvironmentId } from "@kraka/protocol";
import * as v from "valibot";

// Publish the first ID atomically. Both authorities retain IDs already committed by earlier versions.
export function directoryEnvironmentId(dir: string, registered?: EnvironmentId) {
  const path = join(dir, "environment.id");
  let initial = registered;
  const read = () => {
    const id = v.parse(EnvironmentIdSchema, readFileSync(path, "utf8"));
    if (initial && initial !== id) throw Error("Access identity conflicts with durable writer");
    return id;
  };
  if (existsSync(path)) return read();
  const access = join(dir, "access.sqlite");
  if (!initial && existsSync(access)) {
    const db = new Database(access, { readonly: true });
    try {
      if (
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_identity'").get()
      ) {
        const row = db
          .query<{ id: string }, []>("SELECT id FROM host_identity WHERE singleton=1")
          .get();
        if (row) initial = v.parse(EnvironmentIdSchema, row.id);
      }
    } finally {
      db.close();
    }
  }
  const temporary = path + "." + crypto.randomUUID() + ".tmp";
  try {
    writeFileSync(temporary, initial ?? crypto.randomUUID(), {
      mode: 0o600,
      flag: "wx",
      flush: true,
    });
    try {
      linkSync(temporary, path);
    } catch (e) {
      if (!(e instanceof Error && "code" in e && e.code === "EEXIST")) throw e;
    }
    return read();
  } finally {
    rmSync(temporary, { force: true });
  }
}
