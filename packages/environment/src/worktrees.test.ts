import { DirectoryRecordSchema, ProjectSchema, ThreadSchema } from "@kraka/protocol";
import { directoryForThread } from "./worktrees";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AttemptIdSchema,
  CommandIdSchema,
  GitObjectIdSchema,
  WorktreeAddressSchema,
  WorktreeGenerationSchema,
  type WorktreeOrigin,
} from "@kraka/protocol";
import {
  inspectCleanup,
  reconcileWorktree,
  projectWorktree,
  reserveWorktree,
  selectRebuildOrigin,
  transitionWorktree,
  type WorktreeClaim,
  type WorktreeEvent,
  type WorktreeObservation,
  type CleanupInspection,
} from "./worktrees";
const address = v.parse(WorktreeAddressSchema, {
  environmentId: "env",
  projectId: "repo",
  threadId: "thread",
  worktreeId: "slot",
});
const generation = v.parse(WorktreeGenerationSchema, "1"),
  op = v.parse(CommandIdSchema, "create"),
  cleanOp = v.parse(CommandIdSchema, "cleanup");
const commit = v.parse(GitObjectIdSchema, "1".repeat(40));
const origin: WorktreeOrigin = { kind: "selected", ref: "main", commit, prior: { kind: "first" } };
const reservation = reserveWorktree(address, "feature", generation, op, origin),
  ticket = { generation, operationId: op };
const cleanup: Extract<CleanupInspection, { kind: "inspected" }> = {
  kind: "inspected",
  head: commit,
  occupied: false,
  publication: "published",
  staged: [],
  unstaged: [],
  untracked: [],
  ignored: [],
};
const nothing: WorktreeObservation = {
  address,
  generation,
  operationId: op,
  branch: "absent",
  registration: "absent",
  disk: "absent",
  child: { kind: "none" },
  setup: { kind: "unobserved" },
  buildResult: "interrupted",
  cleanup,
};
const complete: WorktreeObservation = {
  ...nothing,
  branch: "expected",
  registration: "owned",
  disk: "verifiedCheckout",
};
const proc = { pid: 310, startedAt: 2000 };
const attempt = v.parse(AttemptIdSchema, "setup");
function step(c: WorktreeClaim, e: WorktreeEvent): WorktreeClaim {
  const r = transitionWorktree(c, e);
  if (r.kind === "rejected") throw new Error(r.reason);
  return r.value;
}
test("recovers crashes before reservation, after reservation, after branch creation, during checkout and after registration", () => {
  expect(reconcileWorktree(null, { ...nothing, operationId: null }).action).toBe("idle");
  expect(reconcileWorktree(null, complete).action).toBe("inspect");
  expect(reconcileWorktree(reservation, nothing).action).toBe("build");
  expect(reconcileWorktree(reservation, { ...nothing, buildResult: "failed" }).action).toBe(
    "recordBuildUndone",
  );
  expect(reconcileWorktree(reservation, { ...nothing, branch: "expected" }).action).toBe(
    "registerCheckout",
  );
  for (const partial of [
    { ...complete, disk: "absent" },
    { ...complete, disk: "ownedPartial" },
    { ...complete, registration: "absent", disk: "ownedPartial" },
  ] as const)
    expect(reconcileWorktree(reservation, partial).action).toBe("repairUnpublishedCheckout");
  expect(reconcileWorktree(reservation, complete).action).toBe("recordVerified");
  for (const foreign of [
    { ...complete, registration: "foreign" },
    { ...complete, disk: "foreign" },
    { ...complete, branch: "foreign" },
    { ...complete, disk: "unknown" },
  ] as const)
    expect(reconcileWorktree(reservation, foreign).action).toBe("inspect");
});

test("waits or stops only the recorded Git process and fences PID reuse and late exits", () => {
  const building = step(reservation, { ...ticket, kind: "gitStarted", process: proc });
  const alive = { ...complete, child: { kind: "alive" as const, process: proc } };
  expect(reconcileWorktree(building, alive)).toEqual({ action: "waitForGit", process: proc });
  expect(reconcileWorktree(building, alive, "stop")).toEqual({ action: "stopGit", process: proc });
  const reused = { ...proc, startedAt: proc.startedAt + 1 };
  expect(
    reconcileWorktree(building, { ...alive, child: { kind: "alive", process: reused } }, "stop")
      .action,
  ).toBe("inspect");
  expect(reconcileWorktree(reservation, alive, "stop").action).toBe("inspect");
  expect(reconcileWorktree(building, { ...complete, child: { kind: "unknown" } }).action).toBe(
    "inspect",
  );
  expect(transitionWorktree(building, { ...ticket, kind: "verified" }).kind).toBe("rejected");
  expect(transitionWorktree(building, { ...ticket, kind: "gitExited", process: reused }).kind).toBe(
    "rejected",
  );
  expect(reconcileWorktree(building, complete).action).toBe("clearChild");
  const exited = step(building, { ...ticket, kind: "gitExited", process: proc });
  expect(reconcileWorktree(exited, complete).action).toBe("recordVerified");
});

test("recovers a setup crash without rerunning a script or accepting a late result from the prior attempt", () => {
  const preparing = step(reservation, { ...ticket, kind: "verified" });
  expect(reconcileWorktree(preparing, complete).action).toBe("resumeSetup");
  const started = step(preparing, { ...ticket, kind: "startSetup", attemptId: attempt });
  expect(reconcileWorktree(started, complete).action).toBe("recordSetupUnknown");
  for (const [kind, action] of [
    ["running", "waitForSetup"],
    ["passed", "recordSetupPassed"],
    ["failed", "recordSetupFailed"],
  ] as const)
    expect(
      reconcileWorktree(started, {
        ...complete,
        setup: { kind, attemptId: attempt, reason: "exit 1" },
      }).action,
    ).toBe(action);
  const lost = step(started, { ...ticket, kind: "setupLost", attemptId: attempt });
  expect(reconcileWorktree(lost, complete).action).toBe("awaitSetupDecision");
  const next = v.parse(AttemptIdSchema, "retry");
  const retry = step(lost, {
    ...ticket,
    kind: "retrySetup",
    previousAttemptId: attempt,
    attemptId: next,
  });
  expect(
    transitionWorktree(retry, { ...ticket, kind: "setupPassed", attemptId: attempt }).kind,
  ).toBe("rejected");
  const ready = step(retry, { ...ticket, kind: "setupPassed", attemptId: next });
  expect(reconcileWorktree(ready, complete).action).toBe("useReady");
  expect(projectWorktree(ready, complete).availability).toBe("usable");
  expect(projectWorktree(ready, { ...complete, registration: "foreign" }).availability).toBe(
    "needsInspection",
  );
  expect(reconcileWorktree(ready, { ...complete, disk: "ownedPartial" }).action).toBe("inspect");
});

test("keeps ignored, staged, modified, untracked, occupied and unpublished worktrees by default", () => {
  const ready = step(step(reservation, { ...ticket, kind: "verified" }), {
    ...ticket,
    kind: "skipSetup",
  });
  for (const category of ["ignored", "staged", "unstaged", "untracked"] as const) {
    const observation = { ...cleanup, [category]: ["keep-me"] };
    expect(inspectCleanup(observation)).toEqual({
      kind: "keep",
      reason: { kind: "files", paths: ["keep-me"] },
    });
    expect(
      transitionWorktree(ready, {
        generation,
        operationId: cleanOp,
        kind: "clean",
        inspection: observation,
      }).kind,
    ).toBe("rejected");
  }
  expect(inspectCleanup({ ...cleanup, occupied: true })).toEqual({
    kind: "keep",
    reason: { kind: "occupied" },
  });
  expect(inspectCleanup({ ...cleanup, publication: "unpublished" })).toEqual({
    kind: "keep",
    reason: { kind: "unpublished" },
  });
  expect(inspectCleanup({ kind: "unreadable" })).toEqual({
    kind: "keep",
    reason: { kind: "uncertain" },
  });
});

test("rechecks removal after a crash on either side of deregistration and protects a rebuilt generation", () => {
  const ready = step(step(reservation, { ...ticket, kind: "verified" }), {
    ...ticket,
    kind: "skipSetup",
  });
  const removing = step(ready, {
    generation,
    operationId: cleanOp,
    kind: "clean",
    inspection: cleanup,
  });
  const seen = { ...complete, operationId: cleanOp };
  for (const half of [
    seen,
    { ...seen, disk: "absent" },
    { ...seen, registration: "absent" },
  ] as const)
    expect(reconcileWorktree(removing, half).action).toBe("continueCleanup");
  expect(
    reconcileWorktree(removing, { ...seen, cleanup: { ...cleanup, ignored: ["new-file"] } }).action,
  ).toBe("keep");
  expect(reconcileWorktree(removing, { ...seen, cleanup: { ...cleanup, head: null } }).action).toBe(
    "inspect",
  );
  expect(reconcileWorktree(removing, { ...nothing, operationId: cleanOp }).action).toBe(
    "recordRemoved",
  );
  const absent = step(removing, { kind: "removed", generation, operationId: cleanOp });
  expect(absent.phase).toEqual({ kind: "absent", previousHead: commit });
  const next = v.parse(WorktreeGenerationSchema, "2");
  const revived = step(absent, {
    kind: "rebuild",
    generation,
    nextGeneration: next,
    operationId: v.parse(CommandIdSchema, "rebuild"),
    origin: {
      kind: "localBranch",
      commit,
      ref: "feature",
      prior: { kind: "rebuild", previousHead: commit, oldFiles: "notRestored" },
    },
  });
  expect(reconcileWorktree(revived, seen).action).toBe("inspect");
  expect(
    transitionWorktree(revived, { kind: "removed", generation, operationId: cleanOp }).kind,
  ).toBe("rejected");
});

test("rebuilds from the first confirmed ref and never treats an unreadable ref as missing", () => {
  const local = { kind: "present" as const, ref: "feature", commit },
    missing = { kind: "missing" as const };
  expect(
    selectRebuildOrigin(commit, { localBranch: local, remoteTracking: local, projectHead: local })
      ?.kind,
  ).toBe("localBranch");
  expect(
    selectRebuildOrigin(commit, { localBranch: missing, remoteTracking: local, projectHead: local })
      ?.kind,
  ).toBe("remoteTracking");
  expect(
    selectRebuildOrigin(commit, {
      localBranch: missing,
      remoteTracking: missing,
      projectHead: local,
    })?.kind,
  ).toBe("projectHead");
  expect(
    selectRebuildOrigin(commit, {
      localBranch: { kind: "unreadable" },
      remoteTracking: local,
      projectHead: local,
    }),
  ).toBeNull();
});

test("a stale or foreign temporary directory never resolves to the project root", () => {
  const project = v.parse(ProjectSchema, { id: "p", environmentId: "env", version: "1" });
  const directory = v.parse(DirectoryRecordSchema, {
    binding: { kind: "temporary", directoryId: "temp", generation: "1", ownerThreadId: "owner" },
    projectId: "p",
    environmentId: "env",
    realPath: "/scratch/owner",
  });
  const thread = v.parse(ThreadSchema, {
    id: "owner",
    projectId: "p",
    worktreeId: null,
    title: "work",
    lineage: { kind: "root" },
    version: "1",
    directory: directory.binding,
  });
  expect(directoryForThread(thread, project, directory, null)).toBe(directory.realPath);
  expect(
    directoryForThread(v.parse(ThreadSchema, { ...thread, id: "other" }), project, directory, null),
  ).toBeNull();
  const stale = v.parse(DirectoryRecordSchema, {
    ...directory,
    binding: { ...directory.binding, generation: "2" },
  });
  expect(directoryForThread(thread, project, stale, null)).toBeNull();
});
