import { Database } from "bun:sqlite";
import { writerGitPaths } from "./private-git";
import { WriterRecovery } from "./writer-recovery";
import { DiffCleanup } from "./diff-cleanup";
import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitStatusCache, gitStatusProcessCount, readGitStatus } from "./git-status";
import { RemoteStatusCache, type VerifiedRemote, probeRemote } from "./git-remote";
import { LocalDiffService } from "./local-diff";
import { GitObjectIdSchema, ThreadIdSchema, WorkspaceTargetSchema } from "@kraka/protocol";
import * as v from "valibot";

const target = v.parse(WorkspaceTargetSchema, {
  kind: "thread",
  threadId: "t-local-diff",
  directoryId: "dir-local-diff",
  generation: "1",
});
const threadId = v.parse(ThreadIdSchema, "t-local-diff");
function git(directory: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: join(directory, "..", "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: "S15 fixture",
      GIT_AUTHOR_EMAIL: "s15@example.invalid",
      GIT_COMMITTER_NAME: "S15 fixture",
      GIT_COMMITTER_EMAIL: "s15@example.invalid",
    },
  });
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}
function repository() {
  const root = mkdtempSync(join(tmpdir(), "kraka-s15-git-"));
  const path = join(root, "checkout");
  const db = new Database(":memory:");
  const cleanup = new DiffCleanup(db, writerGitPaths(root, "git-fixture"));
  const close = () => {
    db.close(true);
    rmSync(root, { recursive: true, force: true });
  };
  try {
    writeFileSync(join(root, "gitconfig"), "");
    mkdirSync(path);
    git(path, "init", "-q", "-b", "main");
    git(path, "config", "user.name", "S15 fixture");
    git(path, "config", "user.email", "s15@example.invalid");
    git(path, "config", "core.autocrlf", "false");
    return { path, close, cleanup, db };
  } catch (error) {
    close();
    throw error;
  }
}
function rootAddress(directory: string) {
  return {
    path: directory,
    address: {
      kind: "projectRoot" as const,
      threadId,
      directoryId: target.directoryId,
      generation: target.generation,
    },
  };
}

test("reads detailed Git changes and shares a one-second physical probe", () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.path, "tracked.txt"), "before\n");
    git(repo.path, "add", "tracked.txt");
    git(repo.path, "commit", "-qm", "initial");
    writeFileSync(join(repo.path, "tracked.txt"), "after\n");
    writeFileSync(join(repo.path, "untracked.txt"), "new\n");

    const detailed = readGitStatus({
      target,
      granularity: "detailed",
      authorizedDirectory: repo.path,
      sequence: 1,
    });
    expect(detailed).toMatchObject({
      kind: "detailed",
      head: { kind: "branch", name: "main" },
      unstaged: [{ path: "tracked.txt", status: ".M", insertions: 1, deletions: 1 }],
      untracked: ["untracked.txt"],
      remote: { kind: "unverified" },
    });

    let now = 0,
      starts = 0;
    const cache = new GitStatusCache(() => now);
    const read = () =>
      cache.read({
        environmentId: "env-s15",
        target,
        granularity: "branch",
        authorizedDirectory: repo.path,
        onGitProcess: () => starts++,
      });
    read();
    const afterFirstRead = starts;
    expect(afterFirstRead).toBeGreaterThan(0);
    now = 999;
    read();
    expect(starts).toBe(afterFirstRead);
    const afterRepeat = starts;
    now = 1_000;
    read();
    expect(starts).toBe(afterFirstRead * 2);
    console.log(
      JSON.stringify({
        granularity: "branch",
        coldGitStarts: afterFirstRead,
        additionalStartsAt999ms: afterRepeat - afterFirstRead,
        additionalStartsAt1000ms: starts - afterRepeat,
      }),
    );
    cache.close();
    expect(gitStatusProcessCount(realpathSync.native(repo.path), "branch")).toBeGreaterThanOrEqual(
      starts,
    );
  } finally {
    repo.close();
  }
});

test("returns invalidated for a stale directory generation and distinguishes a non-repository", () => {
  const repo = repository();
  const empty = mkdtempSync(join(tmpdir(), "kraka-s15-empty-"));
  try {
    const cache = new GitStatusCache(() => 0);
    const stale = v.parse(WorkspaceTargetSchema, {
      ...target,
      generation: "2",
    });
    expect(
      cache.read({
        environmentId: "env-s15",
        target: stale,
        granularity: "branch",
        authorizedDirectory: null,
      }),
    ).toMatchObject({ kind: "invalidated", sequence: 1, granularity: "branch" });
    expect(
      readGitStatus({ target, granularity: "detailed", authorizedDirectory: empty, sequence: 1 }),
    ).toMatchObject({ kind: "notRepository", sequence: 1 });
  } finally {
    repo.close();
    rmSync(empty, { recursive: true, force: true });
  }
});

test("pins a working-tree comparison without changing the real index or HEAD", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.path, "base.txt"), "base\n");
    git(repo.path, "add", "base.txt");
    git(repo.path, "commit", "-qm", "initial");
    writeFileSync(join(repo.path, "base.txt"), "modified\n");
    writeFileSync(join(repo.path, "staged.txt"), "staged before\n");
    git(repo.path, "add", "staged.txt");
    writeFileSync(join(repo.path, "staged.txt"), "staged after\n");
    writeFileSync(join(repo.path, "new.txt"), "new file\n");
    const headBefore = git(repo.path, "rev-parse", "HEAD");
    const indexPath = join(repo.path, git(repo.path, "rev-parse", "--git-path", "index"));
    const indexBefore = readFileSync(indexPath);
    const service = new LocalDiffService(repo.cleanup);
    const result = await service.readLocalDiff({
      actor: { scope: "principal\0thread", directoryDiff: true },
      query: {
        kind: "workingTree",
        threadId,
        directoryId: target.directoryId,
        generation: target.generation,
      },
      cursor: null,
      resolvedDirectory: rootAddress(repo.path),
    });
    expect(result.kind).toBe("changed");
    if (result.kind !== "changed") return;
    expect(result.files.map((file) => file.path).sort()).toEqual([
      "base.txt",
      "new.txt",
      "staged.txt",
    ]);
    expect(result.patch).toContain("modified");
    expect(result.from).toMatchObject({ threadId });
    expect(result.to).toMatchObject({
      kind: "workingTree",
      directoryId: target.directoryId,
      generation: target.generation,
    });
    expect(git(repo.path, "rev-parse", "HEAD")).toBe(headBefore);
    expect(readFileSync(indexPath)).toEqual(indexBefore);
  } finally {
    repo.close();
  }
});

test("uses first-parent bytes, reports a missing shallow parent, and follows frozen UTF-8 pages", async () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.path, "value.txt"), "root\n");
    git(repo.path, "add", "value.txt");
    git(repo.path, "commit", "-qm", "root");
    const rootCommit = git(repo.path, "rev-parse", "HEAD");
    writeFileSync(join(repo.path, "value.txt"), "feature\n");
    git(repo.path, "commit", "-qam", "feature");
    const featureCommit = git(repo.path, "rev-parse", "HEAD");
    const branch = await new LocalDiffService(repo.cleanup).readLocalDiff({
      actor: { scope: "principal\0thread", directoryDiff: true },
      query: {
        kind: "commit",
        threadId,
        directoryId: target.directoryId,
        generation: target.generation,
        commit: v.parse(GitObjectIdSchema, featureCommit),
      },
      cursor: null,
      resolvedDirectory: rootAddress(repo.path),
    });
    expect(branch.kind).toBe("changed");
    if (branch.kind === "changed") {
      expect(branch.patch).toContain("root");
      expect(branch.patch).toContain("feature");
      expect(branch.from).toMatchObject({ kind: "git", relation: "firstParent", oid: rootCommit });
      expect(branch.to).toMatchObject({ kind: "git", relation: "commit", oid: featureCommit });
    }

    const missingParentFile = join(repo.path, "missing-parent.commit");
    writeFileSync(
      missingParentFile,
      `tree ${git(repo.path, "rev-parse", "HEAD^{tree}")}\nparent ${"f".repeat(40)}\nauthor S15 fixture <s15@example.invalid> 1 +0000\ncommitter S15 fixture <s15@example.invalid> 1 +0000\n\nshallow child\n`,
    );
    const missingParent = git(repo.path, "hash-object", "-t", "commit", "-w", missingParentFile);
    const unavailable = await new LocalDiffService(repo.cleanup).readLocalDiff({
      actor: { scope: "principal\0thread", directoryDiff: true },
      query: {
        kind: "commit",
        threadId,
        directoryId: target.directoryId,
        generation: target.generation,
        commit: v.parse(GitObjectIdSchema, missingParent),
      },
      cursor: null,
      resolvedDirectory: rootAddress(repo.path),
    });
    expect(unavailable).toMatchObject({ kind: "unavailable", reason: "missingFirstParent" });

    const content = "😀".repeat(2_700_000);
    writeFileSync(join(repo.path, "large.txt"), "old\n");
    git(repo.path, "add", "large.txt");
    git(repo.path, "commit", "-qm", "large baseline");
    writeFileSync(join(repo.path, "large.txt"), `${content}\n`);
    const service = new LocalDiffService(repo.cleanup);
    const query = {
      kind: "workingTree" as const,
      threadId,
      directoryId: target.directoryId,
      generation: target.generation,
    };
    const first = await service.readLocalDiff({
      actor: { scope: "principal\0thread", directoryDiff: true },
      query,
      cursor: null,
      resolvedDirectory: rootAddress(repo.path),
    });
    expect(first.kind).toBe("changed");
    if (first.kind !== "changed" || !first.next) throw Error("Expected a continuation");
    const firstBytes = Buffer.byteLength(first.patch);
    expect(firstBytes).toBeLessThanOrEqual(10_000_000);
    expect(Buffer.from(first.patch).toString("utf8")).toBe(first.patch);
    writeFileSync(join(repo.path, "large.txt"), "changed after open\n");
    const second = await service.readLocalDiff({
      actor: { scope: "principal\0thread", directoryDiff: true },
      query,
      cursor: first.next,
      resolvedDirectory: rootAddress(repo.path),
    });
    expect(second.kind).toBe("changed");
    if (second.kind === "changed") {
      expect(Buffer.byteLength(second.patch)).toBeLessThanOrEqual(10_000_000);
      expect(second.patch).toContain("😀");
      expect(second.patch).not.toContain("changed after open");
    }
  } finally {
    repo.close();
  }
});

test("a new branch drops a late remote result and failed reads back off until verified", async () => {
  const tip = v.parse(GitObjectIdSchema, "a".repeat(40));
  type Remote = VerifiedRemote;
  const probes: ReturnType<typeof Promise.withResolvers<Remote | null>>[] = [];
  let time = 0;
  const remote = new RemoteStatusCache(
    () => time,
    () => {
      const p = Promise.withResolvers<Remote | null>();
      probes.push(p);
      return p.promise;
    },
  );
  const read = (name: string) =>
    remote.read("key", "checkout", { kind: "branch", name, tip }, () => {});
  async function reply(index: number, value: Remote | null) {
    const p = probes[index];
    if (!p) throw Error("Missing probe");
    p.resolve(value);
    await p.promise;
  }
  expect(read("main").kind).toBe("unverified");
  expect(read("task").kind).toBe("unverified");
  await reply(0, { kind: "verified", upstream: "origin/main", ahead: 1, behind: 0 });
  expect(read("task").kind).toBe("unverified");
  await reply(1, null);
  let next = 30000;
  for (const delay of [30000, 60000, 120000, 240000, 480000, 900000, 900000]) {
    const count = probes.length;
    time = next - 1;
    read("task");
    expect(probes.length).toBe(count);
    time = next;
    read("task");
    expect(probes.length).toBe(count + 1);
    await reply(count, null);
    next += Math.min(900000, delay * 2);
  }
  time = next;
  read("task");
  await reply(probes.length - 1, {
    kind: "verified",
    upstream: "origin/task",
    ahead: 0,
    behind: 1,
  });
  expect(read("task")).toMatchObject({ kind: "verified", upstream: "origin/task", behind: 1 });
});

test("verifies divergence against a real local upstream without moving HEAD", async () => {
  const repo = repository();
  try {
    git(repo.path, "commit", "--allow-empty", "-qm", "base");
    git(repo.path, "branch", "upstream", "HEAD");
    git(repo.path, "branch", "--set-upstream-to=upstream", "main");
    git(repo.path, "commit", "--allow-empty", "-qm", "ahead");
    const head = {
      kind: "branch" as const,
      name: "main",
      tip: v.parse(GitObjectIdSchema, git(repo.path, "rev-parse", "HEAD")),
    };
    expect(await probeRemote(repo.path, head, () => {})).toEqual({
      kind: "verified",
      upstream: "upstream",
      ahead: 1,
      behind: 0,
    });
    expect(git(repo.path, "rev-parse", "HEAD")).toBe(head.tip);
  } finally {
    repo.close();
  }
});

test("retries partial cleanup without deleting a changed endpoint or following a repointed ref", async () => {
  const repo = repository(),
    cwd = repo.path;
  try {
    git(cwd, "commit", "--allow-empty", "-qm", "base");
    const base = v.parse(GitObjectIdSchema, git(cwd, "rev-parse", "HEAD"));
    git(cwd, "commit", "--allow-empty", "-qm", "other");
    const other = git(cwd, "rev-parse", "HEAD");
    const intent = repo.cleanup.begin(cwd);
    if (!intent) throw Error("Missing comparison intent");
    expect(await repo.cleanup.pin(intent.id, base, base)).toBe(true);
    const prefix = repo.cleanup.namespace + intent.id;
    git(cwd, "update-ref", prefix + "/from", other, base);
    const exists = () => !!repo.db.query("SELECT id FROM diff_cleanup WHERE id=?").get(intent.id);
    repo.cleanup.release(intent.id);
    expect(exists()).toBe(true);
    expect(git(cwd, "for-each-ref", "--format=%(refname) %(objectname)", prefix)).toBe(
      prefix + "/from " + other,
    );
    git(cwd, "symbolic-ref", prefix + "/from", "refs/heads/main");
    repo.cleanup.release(intent.id);
    expect(exists()).toBe(true);
    expect(git(cwd, "symbolic-ref", prefix + "/from")).toBe("refs/heads/main");
    git(cwd, "symbolic-ref", "--delete", prefix + "/from");
    repo.cleanup.release(intent.id);
    expect(exists()).toBe(false);
    expect(git(cwd, "rev-parse", "main")).toBe(other);
  } finally {
    repo.close();
  }
});

test.each([false, true])(
  "recovery remembers a completed legacy scan (prior legacy ref: %p)",
  async (hasLegacy) => {
    const repo = repository();
    const trace = join(repo.path, "..", "recovery.trace");
    async function recoveryGitStarts() {
      writeFileSync(trace, "");
      const previous = process.env.GIT_TRACE2_EVENT;
      process.env.GIT_TRACE2_EVENT = trace;
      try {
        const recovery = new WriterRecovery();
        repo.cleanup.registerRecovery(recovery);
        await recovery.run();
      } finally {
        if (previous === undefined) delete process.env.GIT_TRACE2_EVENT;
        else process.env.GIT_TRACE2_EVENT = previous;
      }
      const events = readFileSync(trace, "utf8").split(/\r?\n/).filter(Boolean);
      return events.flatMap((line) => {
        const e = JSON.parse(line);
        return e.event === "start" ? [v.parse(v.array(v.string()), e.argv)] : [];
      });
    }
    try {
      expect(await recoveryGitStarts()).toEqual([]);
      git(repo.path, "commit", "--allow-empty", "-qm", "base");
      const intent = repo.cleanup.begin(repo.path);
      if (!intent) throw Error("Missing comparison intent");
      if (hasLegacy) {
        // An upgrade can open a database with an old cleanup intent and no history table rows.
        repo.db.run("DELETE FROM compared_repositories");
      } else {
        // Completed comparisons must still be known after their intent rows have been released.
        repo.cleanup.release(intent.id);
      }
      const legacy = "refs/kraka/diffs/" + crypto.randomUUID() + "/from";
      if (hasLegacy) git(repo.path, "update-ref", legacy, "HEAD");
      const first = await recoveryGitStarts();
      expect(first.filter((args) => args.includes("--count=1"))).toHaveLength(1);
      expect(repo.db.query("SELECT legacyRef FROM compared_repositories").all()).toEqual([
        { legacyRef: hasLegacy ? legacy : "" },
      ]);
      if (!hasLegacy) git(repo.path, "update-ref", legacy, "HEAD");
      const orphan = repo.cleanup.namespace + crypto.randomUUID() + "/to";
      git(repo.path, "update-ref", orphan, "HEAD");
      const second = await recoveryGitStarts();
      expect(second.some((args) => args.includes("--count=1"))).toBe(false);
      expect(git(repo.path, "for-each-ref", "--format=%(refname)", "refs/kraka/diffs/")).toBe(
        legacy,
      );
    } finally {
      repo.close();
    }
  },
);
