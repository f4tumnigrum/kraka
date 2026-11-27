import { WorkspaceTargetSchema, type GitStatus } from "@kraka/protocol";
import * as v from "valibot";
import { readProject, readThread, type FirstSendStore } from "./first-send-store";
import type { GitGranularity } from "./git-status";
import { GitStatusCache } from "./git-status";
import type { ResolvedDiffDirectory } from "./local-diff";

type WorkspaceTarget = v.InferOutput<typeof WorkspaceTargetSchema>;

export type ResolvedWorkspaceTarget = {
  directory: string;
};

/** Resolve the signed project or thread address against its current directory binding. */
export function resolveWorkspaceTarget(
  store: FirstSendStore,
  target: WorkspaceTarget,
): ResolvedWorkspaceTarget | null {
  if (target.kind === "project") {
    const project = readProject(store.db, target.projectId);
    const root = project?.root;
    if (
      !project ||
      project.environmentId !== store.writer.environmentId ||
      !root ||
      root.directoryId !== target.directoryId ||
      root.generation !== target.generation
    )
      return null;
    const directory = store.projectDirectory(project.id);
    if (!directory || directory !== root.realPath) return null;
    return { directory };
  }
  const thread = readThread(store.db, target.threadId);
  const project = thread ? readProject(store.db, thread.projectId) : null;
  const binding = thread?.directory;
  if (
    !thread ||
    !project ||
    project.environmentId !== store.writer.environmentId ||
    !binding ||
    binding.directoryId !== target.directoryId ||
    binding.generation !== target.generation
  )
    return null;
  const directory = store.directory(thread);
  return directory ? { directory } : null;
}

/** Resolve a local diff query without ever substituting a project path for a stale thread binding. */
export function resolveDiffDirectory(
  store: FirstSendStore,
  query: import("@kraka/protocol").DiffRequest,
): ResolvedDiffDirectory | null {
  if (!("threadId" in query)) return null;
  const thread = readThread(store.db, query.threadId);
  if (!thread || !thread.directory) return null;
  const directory = store.directory(thread);
  if (!directory) return null;
  if ("worktreeId" in query) {
    if (thread.worktreeId !== query.worktreeId || thread.directory.kind !== "managedWorktree")
      return null;
    return {
      path: directory,
      address: {
        kind: "managedWorktree",
        threadId: thread.id,
        worktreeId: query.worktreeId,
        directoryId: thread.directory.directoryId,
        generation: thread.directory.generation,
      },
    };
  }
  if (
    "directoryId" in query &&
    thread.worktreeId === null &&
    thread.directory.kind === "projectRoot" &&
    query.directoryId === thread.directory.directoryId &&
    query.generation === thread.directory.generation
  )
    return {
      path: directory,
      address: {
        kind: "projectRoot",
        threadId: thread.id,
        directoryId: thread.directory.directoryId,
        generation: thread.directory.generation,
      },
    };
  return null;
}

export function readAuthorizedGitStatus(input: {
  store: FirstSendStore;
  cache: GitStatusCache;
  environmentId: string;
  target: WorkspaceTarget;
  granularity: GitGranularity;
  onGitProcess?: (directory: string, granularity: GitGranularity) => void;
}): GitStatus {
  const resolved = resolveWorkspaceTarget(input.store, input.target);
  return input.cache.read({
    environmentId: input.environmentId,
    target: input.target,
    granularity: input.granularity,
    authorizedDirectory: resolved?.directory ?? null,
    ...(input.onGitProcess ? { onGitProcess: input.onGitProcess } : {}),
  });
}
