import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  WorktreeStatusSchema,
  ProcessIdentitySchema,
  WorktreeBranchNamingSchema,
  WorktreeSubmodulesSchema,
  WorktreeLocationSchema,
  WorktreeSelectionSchema,
  DirectoryRecordSchema,
  CommandIdSchema,
  RoundIdSchema,
  SettingReadSchema,
  SettingRowSchema,
  type WorktreeBranchNaming,
  type Project,
  type WorktreeId,
} from "@kraka/protocol";
import { readSetting } from "./settings";
import { physicalDirectory } from "./project-directory";

export const selectionLifetimeMs = 24 * 60 * 60 * 1000;
export const selectionSweepMs = 60 * 60 * 1000;
export const worktreeTables = `
CREATE TABLE IF NOT EXISTS worktree_selections(actor TEXT,project TEXT,worktree TEXT,data TEXT NOT NULL,expires INTEGER NOT NULL,PRIMARY KEY(actor,project,worktree));
CREATE INDEX IF NOT EXISTS selection_expiry ON worktree_selections(expires);
CREATE TABLE IF NOT EXISTS ready_dispatch(round TEXT PRIMARY KEY,worktree TEXT NOT NULL,generation TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS restoring_commands(actor TEXT NOT NULL,command TEXT NOT NULL,intent TEXT NOT NULL,PRIMARY KEY(actor,command));
CREATE TABLE IF NOT EXISTS managed_worktrees(id TEXT PRIMARY KEY,thread TEXT UNIQUE NOT NULL,path TEXT UNIQUE NOT NULL,unfinished INTEGER NOT NULL,data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS preparing_worktrees ON managed_worktrees(id) WHERE unfinished=1;
`;
const settings = v.strictObject({
  worktreeBranchNaming: WorktreeBranchNamingSchema,
  worktreeLocation: WorktreeLocationSchema,
  worktreeSubmodules: WorktreeSubmodulesSchema,
});
const physical = v.strictObject({ realPath: v.string(), identity: v.string() });
const activeWriter = v.strictObject({
  token: v.pipe(v.string(), v.uuid()),
  process: ProcessIdentitySchema,
  kind: v.picklist(["git", "setup"]),
});
export const managedSchema = v.strictObject({
  claim: v.strictObject({
    ...WorktreeStatusSchema.entries,
    gitChild: v.nullable(ProcessIdentitySchema),
    settings,
  }),
  directory: DirectoryRecordSchema,
  root: physical,
  common: physical,
  parent: v.nullable(physical),
  disk: v.nullable(physical),
  admin: v.nullable(physical),
  roundId: RoundIdSchema,
  firstCommand: CommandIdSchema,
  setup: v.nullable(v.tupleWithRest([v.string()], v.string())),
  active: v.nullable(activeWriter),
  inspection: v.boolean(),
  branchOwned: v.boolean(),
});
export type Managed = v.InferOutput<typeof managedSchema>;
export function hashId(id: string) {
  return createHash("sha256").update(id, "utf8").digest("hex");
}
export function worktreeName(id: WorktreeId, naming: WorktreeBranchNaming) {
  const digits = id.replaceAll("-", "").toLowerCase();
  return naming.kind === "generated"
    ? `kraka/wt-${digits}`
    : `${naming.prefix}-${digits.slice(-8)}`;
}
export function policy(state: string, project: Project) {
  const path = join(state, "project-policies", `${hashId(project.id)}.json`);
  const saved = v.parse(
    v.strictObject({
      rows: v.optional(v.array(SettingRowSchema), []),
      setup: v.optional(v.nullable(v.tupleWithRest([v.string()], v.string())), null),
    }),
    existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {},
  );
  const snapshot = {
    environmentId: project.environmentId,
    version: project.version,
    projects: [project],
    worktrees: [],
    rows: saved.rows,
    overlays: [],
  };
  const target = {
    kind: "project" as const,
    environmentId: project.environmentId,
    projectId: project.id,
  };
  const value = (field: keyof typeof settings.entries) =>
    readSetting(
      snapshot,
      v.parse(SettingReadSchema, {
        field,
        target:
          field === "worktreeLocation"
            ? { kind: "environment", environmentId: project.environmentId }
            : target,
        checkout: null,
      }),
    )?.effective.value;
  return {
    settings: v.parse(settings, {
      worktreeBranchNaming: value("worktreeBranchNaming"),
      worktreeLocation: value("worktreeLocation"),
      worktreeSubmodules: value("worktreeSubmodules"),
    }),
    setup: saved.setup,
  };
}
export function readManaged(db: Database, id: string) {
  const row = db
    .query<{ data: string }, [string]>("SELECT data FROM managed_worktrees WHERE id=?")
    .get(id);
  return row ? v.parse(managedSchema, JSON.parse(row.data)) : null;
}
export function saveManaged(db: Database, m: Managed) {
  const unfinished =
    !m.inspection &&
    (m.claim.phase.kind === "building" ||
      (m.claim.phase.kind === "preparing" &&
        ["queued", "started"].includes(m.claim.phase.script.kind)));
  db.run(
    "INSERT INTO managed_worktrees VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data,unfinished=excluded.unfinished",
    [
      m.claim.worktreeId,
      m.claim.threadId,
      m.directory.realPath,
      Number(unfinished),
      JSON.stringify(m),
    ],
  );
}
export function selection(db: Database, actor: string, project: string, worktree: string) {
  const row = db
    .query<{ data: string }, [string, string, string, number]>(
      "SELECT data FROM worktree_selections WHERE actor=? AND project=? AND worktree=? AND expires>?",
    )
    .get(actor, project, worktree, Date.now());
  return row ? v.parse(WorktreeSelectionSchema, JSON.parse(row.data)) : null;
}
export function registeredRoot(db: Database, project: Project) {
  const root = project.root && physicalDirectory(project.root.realPath);
  const saved = db
    .query<{ identity: string }, [string]>("SELECT identity FROM projects WHERE id=?")
    .get(project.id);
  return root && root.realPath === project.root?.realPath && root.identity === saved?.identity
    ? root
    : null;
}
