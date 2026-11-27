import { dirname, join, resolve } from "node:path";
import { lstatSync, readFileSync } from "node:fs";
import * as v from "valibot";
import { GitObjectIdSchema, type WorktreeOrigin } from "@kraka/protocol";
import { physicalDirectory } from "./project-directory";
import type { Managed } from "./worktree-storage";
import { projectWorktree, selectRebuildOrigin, type WorktreeObservation } from "./worktrees";

export function gitRead(cwd: string, ...args: string[]) {
  return Bun.spawnSync(["git", "--no-optional-locks", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 300000,
  });
}
export function gitText(cwd: string, ...args: string[]) {
  const r = gitRead(cwd, ...args);
  if (r.exitCode !== 0) throw Error(`Git observation failed: ${args[0]}`);
  return r.stdout.toString().replace(/\r?\n$/, "");
}
export function pinned(cwd: string, ref: string) {
  const r = gitRead(cwd, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`);
  const oid = v.safeParse(GitObjectIdSchema, r.stdout.toString().trim());
  return r.exitCode === 0 && oid.success ? oid.output : null;
}
export function selectedCommit(cwd: string, ref: string) {
  if (ref === "HEAD" || /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(ref)) return pinned(cwd, ref);
  const name = ref.startsWith("refs/") ? ref : `refs/heads/${ref}`;
  if (!name.startsWith("refs/heads/") && !name.startsWith("refs/remotes/")) return null;
  if (name.includes("\0") || gitRead(cwd, "check-ref-format", name).exitCode !== 0) return null;
  return pinned(cwd, name);
}
export function commonDirectory(cwd: string) {
  return physicalDirectory(gitText(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"));
}
export function validBranch(cwd: string, name: string) {
  return (
    !name.startsWith("-") &&
    !name.includes("\0") &&
    gitRead(cwd, "check-ref-format", "--branch", name).stdout.toString().trimEnd() === name &&
    gitRead(cwd, "check-ref-format", `refs/heads/${name}`).exitCode === 0
  );
}
export function exists(path: string) {
  try {
    lstatSync(path);
    return true;
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return false;
    throw e;
  }
}
export function ownerRef(m: Managed) {
  return `refs/kraka/worktrees/${m.claim.worktreeId}/${m.claim.generation}`;
}
export function matches(p: Managed["root"]) {
  return Bun.deepEquals(physicalDirectory(p.realPath), p);
}
export function observe(m: Managed): WorktreeObservation {
  const { claim, directory } = m,
    path = directory.realPath,
    repo = m.root.realPath;
  const seen: WorktreeObservation = {
    address: claim,
    generation: claim.generation,
    operationId: claim.operationId,
    buildResult: "interrupted",
    disk: "unknown",
    registration: "unknown",
    branch: "unknown",
    child: { kind: m.active ? "unknown" : "none" },
    setup: { kind: "unobserved" },
    cleanup: { kind: "unreadable" },
  };
  if (m.inspection || !matches(m.root) || !matches(m.common) || (m.parent && !matches(m.parent)))
    return seen;
  try {
    if (!Bun.deepEquals(commonDirectory(repo), m.common)) return seen;
    const phase = claim.phase,
      origin = "origin" in phase ? phase.origin : null;
    const ref = `refs/heads/${claim.branch}`;
    const lookup = gitRead(repo, "show-ref", "--exists", ref);
    const oid = lookup.exitCode === 0 ? pinned(repo, ref) : null;
    seen.branch =
      lookup.exitCode === 2
        ? "absent"
        : !oid
          ? "unknown"
          : (m.branchOwned ||
                (origin?.kind === "localBranch" && origin.prior.kind === "rebuild") ||
                pinned(repo, ownerRef(m)) === oid) &&
              (phase.kind !== "building" || (origin && "commit" in origin && oid === origin.commit))
            ? "expected"
            : "foreign";
    const records = gitText(repo, "worktree", "list", "--porcelain", "-z")
      .split("\0\0")
      .map((row) => row.split("\0"));
    const loc = (row: string[]) => resolve(row[0]?.slice("worktree ".length) ?? "");
    const row = records.find((r) => loc(r) === path);
    seen.registration = row ? "foreign" : "absent";
    if (records.some((r) => loc(r) !== path && r.includes(`branch ${ref}`))) {
      seen.branch = "foreign";
      return seen;
    }
    if (!exists(path)) {
      seen.disk = "absent";
      return seen;
    }
    if (!m.disk || !matches(m.disk)) {
      seen.disk = "foreign";
      return seen;
    }
    seen.disk = "ownedPartial";
    if (!row?.includes(`branch ${ref}`) || !oid || !row.includes(`HEAD ${oid}`)) return seen;
    const admin = physicalDirectory(gitText(path, "rev-parse", "--absolute-git-dir"));
    const back = admin && readFileSync(join(admin.realPath, "gitdir"), "utf8").trimEnd();
    if (
      !admin ||
      dirname(admin.realPath) !== join(m.common.realPath, "worktrees") ||
      (m.admin && !Bun.deepEquals(admin, m.admin)) ||
      resolve(admin.realPath, back || ".") !== join(path, ".git") ||
      !Bun.deepEquals(commonDirectory(path), m.common) ||
      gitText(path, "symbolic-ref", "HEAD") !== ref ||
      pinned(path, "HEAD") !== oid
    )
      return seen;
    seen.registration = "owned";
    if (phase.kind === "building") {
      if (
        gitRead(path, "diff-index", "--cached", "--quiet", oid, "--").exitCode !== 0 ||
        gitRead(path, "diff-files", "--quiet", "--").exitCode !== 0 ||
        gitText(path, "ls-files", "-v", "-z")
          .split("\0")
          .some((s) => s && !s.startsWith("H "))
      )
        return seen;
    }
    seen.disk = "verifiedCheckout";
  } catch {
    seen.disk = "unknown";
  }
  return seen;
}
export function managedView(m: Managed) {
  return projectWorktree(m.claim, observe(m));
}
export function rebuildSource(m: Managed): WorktreeOrigin | null {
  if (m.claim.phase.kind !== "absent" || !matches(m.root) || !matches(m.common)) return null;
  const repo = m.root.realPath;
  const read = (ref: string) => {
    const oid = pinned(repo, ref);
    if (oid) return { kind: "present" as const, ref, commit: oid };
    const absent = gitRead(repo, "show-ref", "--exists", ref).exitCode === 2;
    return { kind: absent ? ("missing" as const) : ("unreadable" as const) };
  };
  return selectRebuildOrigin(m.claim.phase.previousHead, {
    localBranch: read(`refs/heads/${m.claim.branch}`),
    remoteTracking: read(`refs/remotes/origin/${m.claim.branch}`),
    projectHead: read("HEAD"),
  });
}
