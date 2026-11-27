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
  const close = () => rmSync(root, { recursive: true, force: true });
  try {
    writeFileSync(join(root, "gitconfig"), "");
    mkdirSync(path);
    git(path, "init", "-q", "-b", "main");
    git(path, "config", "user.name", "S15 fixture");
    git(path, "config", "user.email", "s15@example.invalid");
    git(path, "config", "core.autocrlf", "false");
    return { path, close };
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

test("pins a working-tree comparison without changing the real index or HEAD", () => {
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
    const service = new LocalDiffService();
    const result = service.readLocalDiff({
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

test("uses first-parent bytes, reports a missing shallow parent, and follows frozen UTF-8 pages", () => {
  const repo = repository();
  try {
    writeFileSync(join(repo.path, "value.txt"), "root\n");
    git(repo.path, "add", "value.txt");
    git(repo.path, "commit", "-qm", "root");
    const rootCommit = git(repo.path, "rev-parse", "HEAD");
    writeFileSync(join(repo.path, "value.txt"), "feature\n");
    git(repo.path, "commit", "-qam", "feature");
    const featureCommit = git(repo.path, "rev-parse", "HEAD");
    const branch = new LocalDiffService().readLocalDiff({
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
    const unavailable = new LocalDiffService().readLocalDiff({
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
    const service = new LocalDiffService();
    const query = {
      kind: "workingTree" as const,
      threadId,
      directoryId: target.directoryId,
      generation: target.generation,
    };
    const first = service.readLocalDiff({
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
    const second = service.readLocalDiff({
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
