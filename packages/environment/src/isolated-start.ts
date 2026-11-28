import { join } from "node:path";
import * as v from "valibot";
import {
  WorktreeSelectionSchema,
  WorktreeGenerationSchema,
  type Project,
  type ThreadId,
  type WorktreeId,
  type RoundId,
  type SignedRequest,
} from "@kraka/protocol";
import { settingsSnapshot } from "./setting-store";
import { readProject } from "./first-send-store";
import { recordCommand, reject, type FirstSendContext } from "./command-receipts";
import { REQUEST_METHODS } from "@kraka/protocol";
import {
  commonDirectory,
  exists,
  gitRead,
  pinned,
  selectedCommit,
  validBranch,
} from "./worktree-git";
import {
  hashId,
  registeredRoot,
  policy,
  readManaged,
  saveManaged,
  selection,
  selectionLifetimeMs,
  worktreeName,
} from "./worktree-storage";
import { reserveWorktree } from "./worktrees";
import { managedView } from "./worktree-git";
type Prepare = Extract<SignedRequest, { method: "worktree.prepare" }>["payload"];
const uuid = v.pipe(
  v.string(),
  v.uuid("Expected worktree UUID"),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
);
export function selectWorktreeBase(ctx: FirstSendContext, payload: Prepare) {
  return recordCommand(
    ctx,
    REQUEST_METHODS.prepareWorktree,
    payload,
    { kind: "project", projectId: payload.projectId },
    () => {
      const { db } = ctx.transaction;
      const { projectId, worktreeId, branch, baseRef } = payload;
      if ("threadId" in payload) {
        const m = readManaged(db, worktreeId);
        if (!m || m.claim.threadId !== payload.threadId || m.claim.projectId !== projectId)
          return reject(ctx.commandId, "notFound");
        if (
          m.claim.branch !== branch ||
          (baseRef !== null &&
            (!("origin" in m.claim.phase) ||
              !("ref" in m.claim.phase.origin) ||
              m.claim.phase.origin.ref !== baseRef))
        )
          return reject(ctx.commandId, "idConflict");
        return { kind: "worktreeStatus", view: managedView(m) };
      }
      if (!v.is(uuid, worktreeId) || !baseRef) return reject(ctx.commandId, "invalidState");
      const old = selection(db, ctx.actor.id, projectId, worktreeId);
      if (old)
        return old.branch === branch && old.baseRef === baseRef
          ? old
          : reject(ctx.commandId, "idConflict");
      if (readManaged(db, worktreeId)) return reject(ctx.commandId, "idConflict");
      const project = readProject(db, projectId);
      const root =
        project && project.environmentId === ctx.actor.environmentId && registeredRoot(db, project);
      if (!root) return reject(ctx.commandId, "notFound");
      const commit = selectedCommit(root.realPath, baseRef);
      if (!commit || !validBranch(root.realPath, branch))
        return reject(ctx.commandId, "invalidState");
      const result = v.parse(WorktreeSelectionSchema, {
        kind: "worktreeBaseSelected",
        projectId,
        worktreeId,
        branch,
        baseRef,
        commit,
      });
      db.run("INSERT OR REPLACE INTO worktree_selections VALUES(?,?,?,?,?)", [
        ctx.actor.id,
        projectId,
        worktreeId,
        JSON.stringify(result),
        Date.now() + selectionLifetimeMs,
      ]);
      return result;
    },
  );
}
export function acceptIsolatedStart({
  actor,
  commandId,
  project,
  threadId,
  roundId,
  worktreeId,
  selectedOrigin,
  transaction,
}: FirstSendContext & {
  project: Project;
  threadId: ThreadId;
  roundId: RoundId;
  worktreeId: WorktreeId;
  selectedOrigin: ReturnType<typeof selection>;
}) {
  const { db, writer } = transaction;
  const root = registeredRoot(db, project);
  if (!root || !v.is(uuid, worktreeId) || readManaged(db, worktreeId)) return null;
  const snapshot = settingsSnapshot(transaction, {
    target: { kind: "project", environmentId: project.environmentId, projectId: project.id },
    checkout: null,
  });
  if (!snapshot) return null;
  const config = policy(writer.stateDirectory, project, snapshot);
  const branch =
    selectedOrigin?.branch ?? worktreeName(worktreeId, config.settings.worktreeBranchNaming);
  const commit = selectedOrigin?.commit ?? pinned(root.realPath, "HEAD");
  if (
    !commit ||
    !validBranch(root.realPath, branch) ||
    gitRead(root.realPath, "show-ref", "--exists", `refs/heads/${branch}`).exitCode !== 2
  )
    return null;
  const common = commonDirectory(root.realPath);
  const location = config.settings.worktreeLocation;
  const path = join(
    location.kind === "custom" ? location.path : join(writer.stateDirectory, "worktrees"),
    hashId(project.id),
    hashId(worktreeId),
  );
  if (!common || exists(path)) return null;
  const generation = v.parse(WorktreeGenerationSchema, "1");
  const claim = reserveWorktree(
    { environmentId: project.environmentId, projectId: project.id, threadId, worktreeId },
    branch,
    generation,
    commandId,
    {
      kind: selectedOrigin ? "selected" : "projectHead",
      ref: selectedOrigin?.baseRef ?? "HEAD",
      commit,
      prior: { kind: "first" },
    },
    config.settings,
  );
  const binding = {
    kind: "managedWorktree" as const,
    ownerThreadId: threadId,
    worktreeId,
    directoryId: crypto.randomUUID(),
    generation,
  };
  saveManaged(db, {
    claim: { ...claim, settings: config.settings },
    directory: {
      environmentId: project.environmentId,
      projectId: project.id,
      binding,
      realPath: path,
    },
    firstCommand: commandId,
    roundId,
    root,
    common,
    setup: config.setup,
    parent: null,
    disk: null,
    admin: null,
    active: null,
    inspection: false,
    branchOwned: false,
  });
  db.run("DELETE FROM worktree_selections WHERE actor=? AND project=? AND worktree=?", [
    actor.id,
    project.id,
    worktreeId,
  ]);
  return binding;
}
