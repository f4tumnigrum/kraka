import { linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { EnvironmentIdSchema, type EnvironmentId } from "@kraka/protocol";

function missing(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
/** Publish one complete ID across access enrollment and the durable writer. */
export function stateEnvironmentId(directory: string, registered?: EnvironmentId) {
  const file = join(directory, "environment.id");
  const read = () => v.parse(EnvironmentIdSchema, readFileSync(file, "utf8"));
  try {
    const id = read();
    if (registered && id !== registered)
      throw Error("Access identity conflicts with durable writer");
    return id;
  } catch (error) {
    if (!missing(error)) throw error;
  }
  // Older access-only installations stored their public ID with the signing key.
  let preferred = registered;
  if (!preferred && Bun.file(join(directory, "access.sqlite")).size > 0) {
    const db = new Database(join(directory, "access.sqlite"), { readonly: true });
    try {
      if (
        db.query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='host_identity'").get()
      ) {
        const row = db
          .query<{ id: string }, []>("SELECT id FROM host_identity WHERE singleton=1")
          .get();
        if (row) preferred = v.parse(EnvironmentIdSchema, row.id);
      }
    } finally {
      db.close();
    }
  }
  const temp = file + "." + crypto.randomUUID();
  writeFileSync(temp, preferred ?? crypto.randomUUID(), { mode: 0o600, flag: "wx", flush: true });
  try {
    linkSync(temp, file);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  } finally {
    unlinkSync(temp);
  }
  const id = read();
  if (preferred && preferred !== id) throw Error("Access identity conflicts with durable writer");
  return id;
}
