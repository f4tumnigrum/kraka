import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  watch,
} from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  canonicalJson,
  ObjectVersionSchema,
  RemoteSettingTargetSchema,
  REQUEST_METHODS,
  SettingCheckoutSchema,
  SettingOverlaySchema,
  SettingReadSchema,
  SettingRowSchema,
  readSettingWritePayload,
  remoteSettings,
  sameSettingTarget,
  type AuthorizationTarget,
  type CommandReceipt,
  type Project,
  type RemoteSettingTarget,
  type SettingOverlay,
  type SettingRow,
} from "@kraka/protocol";
import { type FirstSendStore, readProject, readThread } from "./first-send-store";
import { type FirstSendContext, recordCommand, reject } from "./command-receipts";
import { physicalDirectory } from "./project-directory";
import { readManaged, registeredRoot } from "./worktree-storage";
import { applySettingWrite, readSetting, type SettingsSnapshot } from "./settings";

export const settingTables = `
CREATE TABLE IF NOT EXISTS setting_version(singleton INTEGER PRIMARY KEY CHECK(singleton=1), version TEXT NOT NULL);
INSERT OR IGNORE INTO setting_version VALUES(1,'0');
CREATE TABLE IF NOT EXISTS setting_rows(target TEXT, field TEXT, data TEXT NOT NULL, PRIMARY KEY(target,field));
CREATE TABLE IF NOT EXISTS setting_files(binding TEXT PRIMARY KEY,path TEXT NOT NULL,digest TEXT,diagnostic TEXT);
CREATE TABLE IF NOT EXISTS setting_sources(binding TEXT,field TEXT,version TEXT NOT NULL,data TEXT,PRIMARY KEY(binding,field));
`;
const address = v.object({
  target: RemoteSettingTargetSchema,
  checkout: v.nullable(SettingCheckoutSchema),
});
type Address = v.InferOutput<typeof address>;
type Checkout = NonNullable<Address["checkout"]>;
function permissionTarget(t: RemoteSettingTarget): AuthorizationTarget {
  return t.kind === "environment" ? t : { kind: "project", projectId: t.projectId };
}
function version(store: FirstSendStore) {
  return v.parse(
    ObjectVersionSchema,
    store.db.query<{ version: string }, []>("SELECT version FROM setting_version").get()?.version,
  );
}
function next(value: string) {
  return v.parse(ObjectVersionSchema, String(BigInt(value) + 1n));
}
function checkoutDirectory(store: FirstSendStore, project: Project, target: Checkout) {
  const m = readManaged(store.db, target.worktreeId);
  if (
    !m ||
    m.claim.projectId !== project.id ||
    m.claim.environmentId !== store.writer.environmentId ||
    !registeredRoot(store.db, project)
  )
    return null;
  const thread = readThread(store.db, m.claim.threadId);
  const path = thread && store.directory(thread);
  return path && m.disk
    ? { path, disk: m.disk, binding: m.directory.binding, checkout: target }
    : null;
}
type Directory = NonNullable<ReturnType<typeof checkoutDirectory>>;
function sample(dir: Directory) {
  const path = join(dir.path, "kraka.json");
  try {
    const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || realpathSync.native(path) !== path) throw Error("unverified file");
    const fd = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    );
    try {
      const opened = fstatSync(fd, { bigint: true });
      if (
        !opened.isFile() ||
        opened.ino !== before.ino ||
        opened.dev !== before.dev ||
        realpathSync.native(path) !== path
      )
        throw Error("unverified file");
      const bytes = readFileSync(fd);
      const digest = createHash("sha256").update(bytes).digest("hex");
      let data: unknown;
      try {
        data = JSON.parse(bytes.toString("utf8"));
      } catch {
        return { digest, fields: {}, diagnostic: "invalid JSON" };
      }
      const parsed = v.safeParse(v.record(v.string(), v.unknown()), data);
      return parsed.success
        ? { digest, fields: parsed.output, diagnostic: null }
        : { digest, fields: {}, diagnostic: "invalid object" };
    } finally {
      closeSync(fd);
    }
  } catch (e) {
    return {
      digest: null,
      fields: {},
      diagnostic:
        e instanceof Error && "code" in e && e.code === "ENOENT" ? null : "unreadable file",
    };
  }
}
function importRepository(store: FirstSendStore, dir: Directory, file: ReturnType<typeof sample>) {
  const key = canonicalJson(dir.binding);
  if (!Bun.deepEquals(physicalDirectory(dir.path), dir.disk)) return false;
  const db = store.db;
  const prior = db
    .query<{ digest: string | null; diagnostic: string | null }, [string]>(
      "SELECT digest,diagnostic FROM setting_files WHERE binding=?",
    )
    .get(key);
  if (
    prior &&
    prior.digest === file.digest &&
    (file.digest !== null || prior.diagnostic === file.diagnostic)
  )
    return true;
  const fields: Record<string, unknown> = file.fields;
  const diagnostics = Object.keys(fields).filter(
    (k) => !remoteSettings.some((d) => d.repository && d.name === k),
  );
  let changed = false;
  for (const definition of remoteSettings) {
    if (!definition.repository) continue;
    const field = definition.name;
    const raw = fields[field];
    const value = v.safeParse(definition.value, raw);
    if (raw !== undefined && !value.success) diagnostics.push(field);
    const former = db
      .query<{ version: string; data: string | null }, [string, string]>(
        "SELECT version,data FROM setting_sources WHERE binding=? AND field=?",
      )
      .get(key, field);
    const data = value.success ? JSON.stringify(value.output) : null;
    if (data === (former?.data ?? null)) continue;
    db.run("INSERT OR REPLACE INTO setting_sources VALUES(?,?,?,?)", [
      key,
      field,
      next(former?.version ?? "0"),
      data,
    ]);
    changed = true;
  }
  db.run("INSERT OR REPLACE INTO setting_files VALUES(?,?,?,?)", [
    key,
    join(dir.path, "kraka.json"),
    file.digest,
    file.diagnostic ?? (diagnostics.length ? diagnostics.join(", ") : null),
  ]);
  if (changed) db.run("UPDATE setting_version SET version=?", [next(version(store))]);
  return true;
}
function sampleCheckout(store: FirstSendStore, query: Address) {
  const scope = query.checkout ?? query.target;
  if (scope.kind !== "checkout" || scope.environmentId !== store.writer.environmentId) return null;
  const project = readProject(store.db, scope.projectId);
  const dir = project && checkoutDirectory(store, project, scope);
  return dir ? { dir, file: sample(dir) } : null;
}
export function settingsSnapshot(
  store: FirstSendStore,
  query: Address,
  prepared = sampleCheckout(store, query),
): SettingsSnapshot | null {
  const scope = query.checkout ?? query.target;
  if (
    query.target.environmentId !== store.writer.environmentId ||
    scope.environmentId !== store.writer.environmentId ||
    (query.target.kind === "project" &&
      (scope.kind === "environment" || scope.projectId !== query.target.projectId)) ||
    (query.target.kind === "checkout" && !sameSettingTarget(query.target, scope))
  )
    return null;
  const project = scope.kind !== "environment" ? readProject(store.db, scope.projectId) : null;
  if (
    scope.kind !== "environment" &&
    (!project || project.environmentId !== store.writer.environmentId)
  )
    return null;
  const dirs = prepared?.dir;
  if (scope.kind === "checkout" && !dirs) return null;
  const overlays: SettingOverlay[] = [];
  if (dirs) {
    if (!prepared || !importRepository(store, dirs, prepared.file)) return null;
    for (const r of store.db
      .query<{ field: string; version: string; data: string }, [string]>(
        "SELECT field,version,data FROM setting_sources WHERE binding=? AND data IS NOT NULL",
      )
      .all(canonicalJson(dirs.binding)))
      overlays.push(
        v.parse(SettingOverlaySchema, {
          field: r.field,
          version: r.version,
          value: JSON.parse(r.data),
          source: {
            ...dirs.checkout,
            kind: "repository",
            path: "kraka.json",
            generation: dirs.binding.generation,
          },
        }),
      );
  }
  const targets: RemoteSettingTarget[] = [
    { kind: "environment", environmentId: store.writer.environmentId },
  ];
  if (project)
    targets.push({ kind: "project", environmentId: project.environmentId, projectId: project.id });
  if (dirs) targets.push(dirs.checkout);
  const rows: SettingRow[] = targets.flatMap((t) =>
    store.db
      .query<{ data: string }, [string]>("SELECT data FROM setting_rows WHERE target=?")
      .all(canonicalJson(t))
      .map((r) => v.parse(SettingRowSchema, JSON.parse(r.data))),
  );
  return {
    environmentId: store.writer.environmentId,
    version: version(store),
    projects: project ? [project] : [],
    worktrees: dirs ? [{ id: dirs.checkout.worktreeId, projectId: dirs.checkout.projectId }] : [],
    rows,
    overlays,
  };
}

/** Subscribe to the directory so atomic replacement of its configuration file is visible. */
export function watchSettingFile(store: FirstSendStore, checkout: Checkout) {
  const project = readProject(store.db, checkout.projectId);
  const dir = project && checkoutDirectory(store, project, checkout);
  if (!dir) return;
  try {
    const watcher = watch(dir.path, { persistent: false }, (_, name) => {
      if (name !== null && name !== "kraka.json") return;
      if (!Bun.deepEquals(physicalDirectory(dir.path), dir.disk)) {
        watcher.close();
        return;
      }
      try {
        const file = sample(dir);
        store.db.transaction(() => importRepository(store, dir, file))();
      } catch {
        watcher.close();
      }
    });
    watcher.on("error", () => watcher.close());
    return () => watcher.close();
  } catch {
    return;
  }
}

export function settingCommand(
  ctx: FirstSendContext,
  method: "settings.read" | "settings.write",
  payload: unknown,
): CommandReceipt {
  const scope = v.safeParse(address, payload);
  if (!scope.success) return reject(ctx.commandId, "invalidState");
  const { commandId, transaction: store, actor } = ctx;
  const a = scope.output;
  if (
    a.target.environmentId !== store.writer.environmentId ||
    (a.checkout && a.checkout.environmentId !== store.writer.environmentId)
  )
    return reject(commandId, "invalidState");
  const target = permissionTarget(a.target);
  const readScope = permissionTarget(a.checkout ?? a.target);
  if (!actor.allows("thread.view", readScope))
    return {
      kind: "rejected",
      commandId,
      failure: { kind: "missingPermission", permission: "thread.view", target: readScope },
    };
  const op =
    method === "settings.read" ? REQUEST_METHODS.readSetting : REQUEST_METHODS.writeSetting;
  if (!actor.allows(op.permission, target))
    return {
      kind: "rejected",
      commandId,
      failure: { kind: "missingPermission", permission: op.permission, target },
    };
  const prepared = sampleCheckout(store, a);
  return store.db.transaction(() => {
    const view = settingsSnapshot(store, a, prepared);
    if (!view) return reject(commandId, "invalidState");
    return recordCommand(ctx, op, payload, target, () => {
      if (method === "settings.read") {
        const read = v.safeParse(SettingReadSchema, payload);
        const readback = read.success && readSetting(view, read.output);
        return readback ? { kind: "settingRead", readback } : reject(commandId, "invalidState");
      }
      const decoded = readSettingWritePayload(commandId, payload);
      if (decoded.kind === "unrecognized") return decoded.receipt;
      if (decoded.kind === "invalid") return reject(commandId, "invalidState");
      const { snapshot: after, receipt } = applySettingWrite(view, commandId, decoded.edit);
      if (after !== view) {
        const row = after.rows.at(-1);
        if (!row) throw Error("Missing committed setting");
        store.db.run("INSERT OR REPLACE INTO setting_rows VALUES(?,?,?)", [
          canonicalJson(row.target),
          row.field,
          JSON.stringify(row),
        ]);
        store.db.run("UPDATE setting_version SET version=?", [after.version]);
      }
      return receipt;
    });
  })();
}
