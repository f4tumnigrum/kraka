import type {
  AttemptId,
  CommandId,
  GitObjectId,
  ProcessIdentity,
  WorktreeAddress,
  WorktreeGeneration,
  WorktreeOrigin,
  WorktreeRetained,
  WorktreeStatus,
  WorktreeView,
  Thread,
  Project,
  DirectoryRecord,
  SettingValue,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";

type WorktreeSettings = {
  [K in "worktreeLocation" | "worktreeBranchNaming" | "worktreeSubmodules"]: SettingValue<K>;
};
/** Older claims can lack settings. Recovery uses the values frozen for this generation. */
export type WorktreeClaim = WorktreeStatus & {
  gitChild: ProcessIdentity | null;
  settings?: WorktreeSettings;
};
export type CleanupInspection =
  | { kind: "unreadable" }
  | {
      kind: "inspected";
      head: GitObjectId | null;
      occupied: boolean;
      staged: readonly string[];
      unstaged: readonly string[];
      untracked: readonly string[];
      ignored: readonly string[];
      publication: "published" | "unpublished" | "unknown";
    };
export type CleanupDecision =
  | { kind: "remove"; head: GitObjectId | null }
  | { kind: "keep"; reason: WorktreeRetained };

/** All file classes protect the checkout, including ignored files. Reinspect under the same exclusive directory lease. */
export function inspectCleanup(observation: CleanupInspection): CleanupDecision {
  if (observation.kind === "unreadable") return { kind: "keep", reason: { kind: "uncertain" } };
  if (observation.occupied) return { kind: "keep", reason: { kind: "occupied" } };
  const paths = [
    ...new Set([
      ...observation.staged,
      ...observation.unstaged,
      ...observation.untracked,
      ...observation.ignored,
    ]),
  ];
  const first = paths.shift();
  if (first !== undefined)
    return { kind: "keep", reason: { kind: "files", paths: [first, ...paths] } };
  if (observation.publication !== "published")
    return {
      kind: "keep",
      reason: { kind: observation.publication === "unpublished" ? "unpublished" : "uncertain" },
    };
  return { kind: "remove", head: observation.head };
}

/** Commit the address, immutable origin and generation before allowing the first Git writer. */
export function reserveWorktree(
  address: WorktreeAddress,
  branch: string,
  generation: WorktreeGeneration,
  operationId: CommandId,
  origin: WorktreeOrigin,
  settings?: WorktreeSettings,
): WorktreeClaim {
  return {
    ...address,
    branch,
    generation,
    operationId,
    phase: { kind: "building", origin },
    gitChild: null,
    ...(settings && { settings }),
  };
}
function sameProcess(a: ProcessIdentity, b: ProcessIdentity) {
  return a.pid === b.pid && a.startedAt === b.startedAt;
}
export type WorktreeEvent = { generation: WorktreeGeneration; operationId: CommandId } & (
  | { kind: "gitStarted"; process: ProcessIdentity }
  | { kind: "gitExited"; process: ProcessIdentity }
  | { kind: "verified" | "skipSetup" | "retain" | "removed" | "buildUndone" }
  | { kind: "startSetup"; attemptId: AttemptId }
  | { kind: "retrySetup"; attemptId: AttemptId; previousAttemptId: AttemptId }
  | { kind: "setupPassed"; attemptId: AttemptId }
  | { kind: "setupLost"; attemptId: AttemptId }
  | { kind: "setupFailed"; attemptId: AttemptId; reason: string }
  | { kind: "clean"; inspection: CleanupInspection }
  | {
      kind: "rebuild";
      nextGeneration: WorktreeGeneration;
      origin: WorktreeOrigin;
    }
);
export type WorktreeTransition =
  | TransitionResult<WorktreeClaim>
  | { kind: "rejected"; reason: "worktreeRetained"; protection: WorktreeRetained };
export function transitionWorktree(claim: WorktreeClaim, event: WorktreeEvent): WorktreeTransition {
  if (claim.generation !== event.generation) return reject("idConflict");
  if (event.kind !== "clean" && event.kind !== "rebuild" && event.operationId !== claim.operationId)
    return reject("idConflict");
  const p = claim.phase;
  if (event.kind === "gitStarted") {
    if (p.kind !== "building" && p.kind !== "removing") return reject("invalidState");
    if (claim.gitChild && !sameProcess(claim.gitChild, event.process)) return reject("idConflict");
    return ok({ ...claim, gitChild: event.process });
  }
  if (event.kind === "gitExited") {
    if (!claim.gitChild || !sameProcess(claim.gitChild, event.process)) return reject("idConflict");
    return ok({ ...claim, gitChild: null });
  }
  if (claim.gitChild) return reject("invalidState");
  const set = (phase: WorktreeClaim["phase"]) => ok({ ...claim, phase });
  switch (event.kind) {
    case "verified":
      return p.kind === "building"
        ? set({ kind: "preparing", origin: p.origin, script: { kind: "queued" } })
        : reject("invalidState");
    case "skipSetup":
      return p.kind === "preparing" && p.script.kind === "queued"
        ? set({ kind: "ready", origin: p.origin, setup: "skipped" })
        : reject("invalidState");
    case "startSetup":
    case "retrySetup": {
      if (p.kind !== "preparing") return reject("invalidState");
      if (
        event.kind === "startSetup"
          ? p.script.kind !== "queued"
          : (p.script.kind !== "failed" && p.script.kind !== "unknown") ||
            p.script.attemptId === event.attemptId ||
            p.script.attemptId !== event.previousAttemptId
      )
        return reject("invalidState");
      return set({ ...p, script: { kind: "started", attemptId: event.attemptId } });
    }
    case "setupPassed":
    case "setupLost":
    case "setupFailed":
      if (p.kind !== "preparing" || p.script.kind !== "started") return reject("invalidState");
      if (p.script.attemptId !== event.attemptId) return reject("wrongAttempt");
      if (event.kind === "setupPassed")
        return set({ kind: "ready", origin: p.origin, setup: "passed" });
      return set({
        ...p,
        script:
          event.kind === "setupLost"
            ? { kind: "unknown", attemptId: event.attemptId }
            : { kind: "failed", attemptId: event.attemptId, reason: event.reason },
      });
    case "clean": {
      if (p.kind !== "ready") return reject("invalidState");
      const verdict = inspectCleanup(event.inspection);
      if (verdict.kind === "keep")
        return { kind: "rejected", reason: "worktreeRetained", protection: verdict.reason };
      return ok({
        ...claim,
        operationId: event.operationId,
        phase: { kind: "removing", saved: p, checkedHead: verdict.head },
      });
    }
    case "retain":
      return p.kind === "removing" ? set(p.saved) : reject("invalidState");
    case "removed":
      return p.kind === "removing"
        ? set({ kind: "absent", previousHead: p.checkedHead })
        : reject("invalidState");
    case "buildUndone":
      return p.kind === "building"
        ? set({
            kind: "absent",
            previousHead: p.origin.prior.kind === "rebuild" ? p.origin.prior.previousHead : null,
          })
        : reject("invalidState");
    case "rebuild":
      return p.kind === "absent" &&
        BigInt(event.nextGeneration) > BigInt(claim.generation) &&
        event.origin.prior.kind === "rebuild" &&
        event.origin.prior.previousHead === p.previousHead
        ? ok({
            ...claim,
            generation: event.nextGeneration,
            operationId: event.operationId,
            phase: { kind: "building", origin: event.origin },
          })
        : reject("invalidState");
    default:
      return unexpected(event);
  }
}

/** Owned resources have verified path, repository and generation. A partial directory is still private to this build.
 * "none" means the directory writer lease is free and no child survives. A missing PID record alone is "unknown".
 */
export interface WorktreeObservation {
  address: WorktreeAddress;
  generation: WorktreeGeneration;
  operationId: CommandId | null;
  buildResult: "interrupted" | "failed";
  disk: "absent" | "verifiedCheckout" | "ownedPartial" | "foreign" | "unknown";
  branch: "absent" | "expected" | "foreign" | "unknown";
  registration: "absent" | "owned" | "foreign" | "unknown";
  child: { kind: "none" | "unknown" } | { kind: "alive"; process: ProcessIdentity };
  setup:
    | { kind: "unobserved" }
    | { kind: "running" | "passed"; attemptId: AttemptId }
    | { kind: "failed"; attemptId: AttemptId; reason: string };
  cleanup: CleanupInspection;
}
export type WorktreeRecovery =
  | { action: "waitForGit" | "stopGit"; process: ProcessIdentity }
  | { action: "keep"; reason: WorktreeRetained }
  | {
      action:
        | "idle"
        | "build"
        | "registerCheckout"
        | "repairUnpublishedCheckout"
        | "recordBuildUndone"
        | "recordVerified"
        | "useReady"
        | "resumeSetup"
        | "waitForSetup"
        | "awaitSetupDecision"
        | "recordSetupUnknown"
        | "recordSetupPassed"
        | "recordSetupFailed"
        | "continueCleanup"
        | "recordRemoved"
        | "clearChild"
        | "inspect";
    };
const action = <T extends WorktreeRecovery["action"]>(value: T) => ({ action: value });
export function reconcileWorktree(
  claim: WorktreeClaim | null,
  seen: WorktreeObservation,
  orphanPolicy: "wait" | "stop" = "wait",
): WorktreeRecovery {
  const { disk, registration, child } = seen;
  const absent = disk === "absent" && registration === "absent";
  if (!claim) return absent ? action("idle") : action("inspect");
  const a = seen.address;
  if (
    claim.generation !== seen.generation ||
    claim.operationId !== seen.operationId ||
    claim.environmentId !== a.environmentId ||
    claim.projectId !== a.projectId ||
    claim.worktreeId !== a.worktreeId ||
    claim.threadId !== a.threadId
  )
    return action("inspect");
  if (child.kind === "unknown") return action("inspect");
  if (child.kind === "alive") {
    if (!claim.gitChild || !sameProcess(claim.gitChild, child.process)) return action("inspect");
    return { action: orphanPolicy === "wait" ? "waitForGit" : "stopGit", process: claim.gitChild };
  }
  if (claim.gitChild) return action("clearChild");
  if (
    seen.branch === "foreign" ||
    seen.branch === "unknown" ||
    disk === "unknown" ||
    registration === "unknown" ||
    disk === "foreign" ||
    registration === "foreign"
  )
    return action("inspect");
  const complete =
    disk === "verifiedCheckout" && registration === "owned" && seen.branch === "expected";
  const phase = claim.phase;
  switch (phase.kind) {
    case "absent":
      return absent ? action("idle") : action("inspect");
    case "building":
      if (absent) {
        if (seen.buildResult === "failed") return action("recordBuildUndone");
        return seen.branch === "expected" ? action("registerCheckout") : action("build");
      }
      if (complete) return action("recordVerified");
      if (disk === "verifiedCheckout" || seen.branch !== "expected") return action("inspect");
      return action("repairUnpublishedCheckout");
    case "preparing": {
      if (!complete) return action("inspect");
      const script = phase.script;
      switch (script.kind) {
        case "queued":
          return action("resumeSetup");
        case "failed":
        case "unknown":
          return action("awaitSetupDecision");
        case "started": {
          const probe = seen.setup;
          if (probe.kind === "unobserved") return action("recordSetupUnknown");
          if (probe.attemptId !== script.attemptId) return action("inspect");
          if (probe.kind === "running") return action("waitForSetup");
          return probe.kind === "passed"
            ? action("recordSetupPassed")
            : action("recordSetupFailed");
        }
        default:
          return unexpected(script);
      }
    }
    case "ready":
      return complete ? action("useReady") : action("inspect");
    case "removing": {
      if (absent) return action("recordRemoved");
      const decision = inspectCleanup(seen.cleanup);
      if (decision.kind === "keep") return { action: "keep", reason: decision.reason };
      return decision.head === phase.checkedHead ? action("continueCleanup") : action("inspect");
    }
    default:
      return unexpected(phase);
  }
}

type RebuildRef =
  | { kind: "present"; ref: string; commit: GitObjectId }
  | { kind: "missing" | "unreadable" };
/** Pin a rebuild source once. A failed lookup does not establish that a higher-priority ref is absent. */
export function selectRebuildOrigin(
  previousHead: GitObjectId | null,
  refs: { localBranch: RebuildRef; remoteTracking: RebuildRef; projectHead: RebuildRef },
): WorktreeOrigin | null {
  for (const kind of ["localBranch", "remoteTracking", "projectHead"] as const) {
    const read = refs[kind];
    if (read.kind === "unreadable") return null;
    if (read.kind === "present")
      return {
        kind,
        ref: read.ref,
        commit: read.commit,
        prior: { kind: "rebuild", previousHead, oldFiles: "notRestored" },
      };
  }
  return null;
}

/** A persisted ready row can expose a usable directory only after all three observations agree. */
export function projectWorktree(claim: WorktreeClaim, seen: WorktreeObservation): WorktreeView {
  const { environmentId, projectId, threadId, worktreeId, branch, generation, operationId, phase } =
    claim;
  const recovery = reconcileWorktree(claim, seen);
  return {
    status: {
      environmentId,
      projectId,
      threadId,
      worktreeId,
      branch,
      generation,
      operationId,
      phase,
    },
    availability:
      recovery.action === "useReady"
        ? "usable"
        : recovery.action === "inspect" ||
            (phase.kind === "preparing" && phase.script.kind === "unknown")
          ? "needsInspection"
          : "unavailable",
  };
}

/** The environment loads the directory record by its durable identity. Never fall back to the project path when a binding is stale. */
export function directoryForThread(
  thread: Thread,
  project: Project,
  directory: DirectoryRecord,
  worktree: WorktreeView | null,
): string | null {
  const binding = thread.directory,
    saved = directory.binding;
  if (
    !binding ||
    thread.projectId !== project.id ||
    directory.projectId !== project.id ||
    directory.environmentId !== project.environmentId ||
    binding.kind !== saved.kind ||
    binding.directoryId !== saved.directoryId ||
    binding.generation !== saved.generation
  )
    return null;
  switch (binding.kind) {
    case "projectRoot": {
      const root = project.root;
      return thread.worktreeId === null &&
        root?.directoryId === binding.directoryId &&
        root.generation === binding.generation &&
        root.realPath === directory.realPath
        ? directory.realPath
        : null;
    }
    case "temporary":
      return thread.worktreeId === null &&
        saved.kind === "temporary" &&
        saved.ownerThreadId === thread.id &&
        binding.ownerThreadId === thread.id
        ? directory.realPath
        : null;
    case "managedWorktree": {
      if (saved.kind !== "managedWorktree" || !worktree || worktree.availability !== "usable")
        return null;
      const { status } = worktree;
      return thread.worktreeId === binding.worktreeId &&
        saved.worktreeId === binding.worktreeId &&
        status.worktreeId === binding.worktreeId &&
        status.projectId === project.id &&
        status.environmentId === project.environmentId &&
        status.generation === binding.generation &&
        status.threadId === binding.ownerThreadId &&
        saved.ownerThreadId === binding.ownerThreadId
        ? directory.realPath
        : null;
    }
  }
}
