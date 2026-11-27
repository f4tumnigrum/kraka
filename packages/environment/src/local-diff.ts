import {
  closeSync,
  copyFileSync,
  existsSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalJson,
  type ThreadId,
  type WorktreeId,
  type WorktreeGeneration,
  DiffEndpointSchema,
  DiffResultSchema,
  GitObjectIdSchema,
  WorkspaceRelativePathSchema,
  type DiffRequest,
  type DiffResult,
  type GitObjectId,
} from "@kraka/protocol";
import * as v from "valibot";
import { gitEnvironment, runGit } from "./git-process";

const logicalPatchBytes = 10_000_000;
const cursorRetentionMs = 60_000;

type OutputEndpoint = v.InferOutput<typeof DiffEndpointSchema>;
type DiffAddress =
  | {
      kind: "managedWorktree";
      threadId: ThreadId;
      worktreeId: WorktreeId;
      directoryId: string;
      generation: WorktreeGeneration;
    }
  | {
      kind: "projectRoot";
      threadId: ThreadId;
      directoryId: string;
      generation: WorktreeGeneration;
    };
export type ResolvedDiffDirectory = { path: string; address: DiffAddress };
export type DiffActor = { scope: string; directoryDiff: boolean };
type DiffFile = Extract<DiffResult, { kind: "changed" }>["files"][number];
type CursorState = {
  actorScope: string;
  query: string;
  directory: ResolvedDiffDirectory;
  pair: EndpointPair;
  paths: ChangedPath[];
  pathIndex: number;
  byteOffset: number;
  scratch: string;
  patchPath: string;
  currentSize: number | null;
  refs: string | null;
};
type EndpointPair = {
  from: OutputEndpoint;
  to: OutputEndpoint;
  fromTree: GitObjectId;
  toTree: GitObjectId;
};
type ChangedPath = { path: string; previousPath: string | null; status: string };

function parsedOid(value: string) {
  const parsed = v.safeParse(GitObjectIdSchema, value);
  return parsed.success ? parsed.output : null;
}

function emptyTree(directory: string) {
  const result = runGit(directory, ["hash-object", "-w", "-t", "tree", "--stdin"], {
    input: new Uint8Array(0),
  });
  return result.exitCode === 0 ? parsedOid(result.stdout.toString().trim()) : null;
}

function commitTree(directory: string, commit: GitObjectId) {
  const result = runGit(directory, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${commit}^{tree}`,
  ]);
  return result.exitCode === 0 ? parsedOid(result.stdout.toString().trim()) : null;
}

function headCommit(directory: string) {
  const result = runGit(directory, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  return result.exitCode === 0 ? parsedOid(result.stdout.toString().trim()) : null;
}

function treeAtWorkingDirectory(directory: string, head: GitObjectId | null) {
  const temporary = mkdtempSync(join(tmpdir(), "kraka-local-diff-"));
  const index = join(temporary, "index");
  try {
    const original = runGit(directory, [
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "index",
    ]);
    if (original.exitCode !== 0) return null;
    const originalPath = original.stdout.toString().replace(/\r?\n$/, "");
    if (existsSync(originalPath)) copyFileSync(originalPath, index);
    else if (
      runGit(directory, head ? ["read-tree", head] : ["read-tree", "--empty"], {
        env: { GIT_INDEX_FILE: index },
      }).exitCode !== 0
    )
      return null;
    const add = runGit(directory, ["add", "-A", "--", "."], {
      env: { GIT_INDEX_FILE: index },
      timeout: 30_000,
    });
    if (add.exitCode !== 0) return null;
    const written = runGit(directory, ["write-tree"], { env: { GIT_INDEX_FILE: index } });
    return written.exitCode === 0 ? parsedOid(written.stdout.toString().trim()) : null;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function localEndpoint(address: DiffAddress) {
  return address.kind === "managedWorktree"
    ? { worktreeId: address.worktreeId }
    : {
        threadId: address.threadId,
        directoryId: address.directoryId,
        generation: address.generation,
      };
}

function gitEndpoint(address: DiffAddress, relation: string, oid: GitObjectId): OutputEndpoint {
  return v.parse(DiffEndpointSchema, {
    kind: "git",
    ...localEndpoint(address),
    relation,
    oid,
  });
}

function workingTreeEndpoint(address: DiffAddress, tree: GitObjectId): OutputEndpoint {
  return v.parse(DiffEndpointSchema, {
    kind: "workingTree",
    ...localEndpoint(address),
    tree,
  });
}

function buildComparison(
  directory: string,
  address: DiffAddress,
  query: DiffRequest,
):
  | { pair: EndpointPair }
  | { reason: string; from: OutputEndpoint | null; to: OutputEndpoint | null } {
  const treeFor = (oid: GitObjectId) => commitTree(directory, oid);
  const root = emptyTree(directory);
  if (!root) return { reason: "gitUnavailable", from: null, to: null };
  if (query.kind === "workingTree") {
    const head = headCommit(directory);
    if (!head) {
      const ref = runGit(directory, ["symbolic-ref", "--quiet", "HEAD"]);
      if (
        ref.exitCode !== 0 ||
        runGit(directory, ["show-ref", "--exists", ref.stdout.toString().trim()]).exitCode !== 2
      )
        return { reason: "headUnavailable", from: null, to: null };
    }
    const fromTree = head ? treeFor(head) : root;
    if (!fromTree) return { reason: "headUnavailable", from: null, to: null };
    const tree = treeAtWorkingDirectory(directory, head);
    const from = head
      ? gitEndpoint(address, "head", head)
      : gitEndpoint(address, "emptyTree", root);
    if (!tree) return { reason: "workingTreeUnavailable", from, to: null };
    return {
      pair: {
        from,
        to: workingTreeEndpoint(address, tree),
        fromTree,
        toTree: tree,
      },
    };
  }
  if (query.kind === "branch") {
    const head = headCommit(directory);
    if (!head) return { reason: "headUnavailable", from: null, to: null };
    const ref = runGit(directory, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${query.baseRef}^{commit}`,
    ]);
    const base = ref.exitCode === 0 ? parsedOid(ref.stdout.toString().trim()) : null;
    const tree = treeAtWorkingDirectory(directory, head);
    const to = tree ? workingTreeEndpoint(address, tree) : null;
    if (!base) return { reason: "baseRefUnavailable", from: null, to };
    const merge = runGit(directory, ["merge-base", head, base]);
    const mergeBase = merge.exitCode === 0 ? parsedOid(merge.stdout.toString().trim()) : null;
    if (!mergeBase) return { reason: "mergeBaseUnavailable", from: null, to };
    const fromTree = treeFor(mergeBase);
    const from = gitEndpoint(address, "mergeBase", mergeBase);
    if (!fromTree || !tree) return { reason: "comparisonUnavailable", from, to: null };
    return {
      pair: {
        from,
        to: workingTreeEndpoint(address, tree),
        fromTree,
        toTree: tree,
      },
    };
  }
  if (query.kind === "commit") {
    const type = runGit(directory, ["cat-file", "-t", query.commit]);
    if (type.exitCode !== 0 || type.stdout.toString().trim() !== "commit")
      return { reason: "commitUnavailable", from: null, to: null };
    const body = runGit(directory, ["cat-file", "-p", query.commit]);
    if (body.exitCode !== 0) return { reason: "commitUnavailable", from: null, to: null };
    const parentLine = (body.stdout.toString().split("\n\n", 1)[0] ?? "")
      .split("\n")
      .find((line) => line.startsWith("parent "));
    const to = gitEndpoint(address, "commit", query.commit);
    const commitTreeOid = treeFor(query.commit);
    if (!commitTreeOid) return { reason: "commitTreeUnavailable", from: null, to };
    if (parentLine) {
      const parent = parsedOid(parentLine.slice("parent ".length));
      if (!parent) return { reason: "missingFirstParent", from: null, to };
      const parentType = runGit(directory, ["cat-file", "-e", `${parent}^{commit}`]);
      if (parentType.exitCode !== 0) return { reason: "missingFirstParent", from: null, to };
      const parentTree = treeFor(parent);
      if (!parentTree)
        return {
          reason: "missingFirstParent",
          from: gitEndpoint(address, "firstParent", parent),
          to,
        };
      return {
        pair: {
          from: gitEndpoint(address, "firstParent", parent),
          to,
          fromTree: parentTree,
          toTree: commitTreeOid,
        },
      };
    }
    return {
      pair: {
        from: gitEndpoint(address, "emptyTree", root),
        to,
        fromTree: root,
        toTree: commitTreeOid,
      },
    };
  }
  return { reason: "capturedComparisonUnsupported", from: null, to: null };
}

function changedPaths(directory: string, fromTree: GitObjectId, toTree: GitObjectId) {
  const prefixResult = runGit(directory, ["rev-parse", "--show-prefix"]);
  if (prefixResult.exitCode !== 0) return null;
  const prefix = prefixResult.stdout.toString().trimEnd();
  const result = runGit(directory, [
    "diff",
    "--name-status",
    "--find-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "-z",
    fromTree,
    toTree,
    "--",
    ".",
  ]);
  if (result.exitCode !== 0) return null;
  const values = result.stdout.toString().split("\0").filter(Boolean);
  const files: ChangedPath[] = [];
  const scopedPath = (path: string) => {
    const value =
      prefix && path.startsWith(prefix) ? path.slice(prefix.length) : prefix ? null : path;
    return value && v.safeParse(WorkspaceRelativePathSchema, value).success ? value : null;
  };
  for (let index = 0; index < values.length; index++) {
    const status = values[index] ?? "";
    if (/^[RC]/.test(status)) {
      const previousPath = values[++index],
        path = values[++index];
      if (!previousPath || !path) return null;
      const scopedPrevious = scopedPath(previousPath),
        scoped = scopedPath(path);
      if (!scopedPrevious || !scoped) return null;
      files.push({ path: scoped, previousPath: scopedPrevious, status });
    } else {
      const path = values[++index];
      if (!path) return null;
      const scoped = scopedPath(path);
      if (!scoped) return null;
      files.push({ path: scoped, previousPath: null, status });
    }
  }
  return files;
}

function ownership(address: DiffAddress) {
  return address.kind === "projectRoot"
    ? { kind: "unknown" as const, reason: "sharedWriter" as const }
    : { kind: "unknown" as const, reason: "noObservation" as const };
}

function diffFile(path: ChangedPath, address: DiffAddress): DiffFile | null {
  const safePath = v.safeParse(WorkspaceRelativePathSchema, path.path);
  const safePrevious = path.previousPath
    ? v.safeParse(WorkspaceRelativePathSchema, path.previousPath)
    : null;
  if (!safePath?.success || (safePrevious && !safePrevious.success)) return null;
  const status = path.status[0];
  const change =
    status === "A" ? "added" : status === "D" ? "removed" : status === "R" ? "renamed" : "modified";
  return {
    path: safePath.output,
    previousPath: safePrevious?.success ? safePrevious.output : null,
    change,
    owner: ownership(address),
  };
}

function preparePatch(state: CursorState, path: ChangedPath) {
  const fd = openSync(state.patchPath, "w", 0o600);
  try {
    const result = Bun.spawnSync(
      [
        "git",
        "--literal-pathspecs",
        "-C",
        state.directory.path,
        "diff",
        "--relative",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        "--full-index",
        "--find-renames",
        state.pair.fromTree,
        state.pair.toTree,
        "--",
        ...(path.previousPath ? [path.previousPath] : []),
        path.path,
      ],
      { env: gitEnvironment(), stdin: "ignore", stdout: fd, stderr: "ignore", timeout: 30000 },
    );
    return result.exitCode === 0 ? fstatSync(fd).size : null;
  } finally {
    closeSync(fd);
  }
}
function pin(state: CursorState) {
  const prefix = "refs/kraka/diffs/" + crypto.randomUUID();
  const from = state.pair.from,
    to = state.pair.to;
  if (from.kind !== "git" || to.kind === "round") return false;
  const right = to.kind === "workingTree" ? to.tree : to.oid;
  const result = runGit(
    state.directory.path,
    ["-c", "core.hooksPath=" + state.scratch, "update-ref", "--stdin"],
    {
      input: Buffer.from(
        "create " + prefix + "/from " + from.oid + "\ncreate " + prefix + "/to " + right + "\n",
      ),
    },
  );
  if (result.exitCode !== 0) return false;
  state.refs = prefix;
  return true;
}
function release(state: CursorState) {
  const { from, to } = state.pair;
  try {
    if (state.refs && from.kind === "git" && to.kind !== "round") {
      const right = to.kind === "workingTree" ? to.tree : to.oid;
      runGit(
        state.directory.path,
        ["-c", "core.hooksPath=" + state.scratch, "update-ref", "--stdin"],
        {
          input: Buffer.from(
            "delete " +
              state.refs +
              "/from " +
              from.oid +
              "\ndelete " +
              state.refs +
              "/to " +
              right +
              "\n",
          ),
        },
      );
    }
  } finally {
    rmSync(state.scratch, { recursive: true, force: true });
  }
}

function unavailable(
  request: DiffRequest,
  reason: string,
  from: OutputEndpoint | null = null,
  to: OutputEndpoint | null = null,
) {
  return v.parse(DiffResultSchema, { kind: "unavailable", request, from, to, reason });
}

function sameDirectory(a: ResolvedDiffDirectory, b: ResolvedDiffDirectory) {
  return a.path === b.path && JSON.stringify(a.address) === JSON.stringify(b.address);
}

function queryAddressMatches(query: DiffRequest, directory: ResolvedDiffDirectory) {
  if ("worktreeId" in query)
    return (
      directory.address.kind === "managedWorktree" &&
      directory.address.threadId === query.threadId &&
      directory.address.worktreeId === query.worktreeId
    );
  if ("directoryId" in query)
    return (
      directory.address.kind === "projectRoot" &&
      directory.address.threadId === query.threadId &&
      directory.address.directoryId === query.directoryId &&
      directory.address.generation === query.generation
    );
  return false;
}

export class LocalDiffService {
  private readonly cursors = new Map<
    string,
    { state: CursorState; timer: ReturnType<typeof setTimeout> }
  >();
  close() {
    for (const key of this.cursors.keys()) this.expire(key);
  }
  private expire(key: string) {
    const entry = this.cursors.get(key);
    if (entry) {
      this.cursors.delete(key);
      clearTimeout(entry.timer);
      release(entry.state);
    }
  }

  readLocalDiff(input: {
    actor: DiffActor;
    query: DiffRequest;
    cursor: string | null;
    resolvedDirectory: ResolvedDiffDirectory;
  }): DiffResult {
    const { actor, query, cursor, resolvedDirectory } = input;
    if (!queryAddressMatches(query, resolvedDirectory)) return unavailable(query, "invalidScope");
    if (resolvedDirectory.address.kind === "projectRoot" && !actor.directoryDiff)
      return unavailable(query, "unsupported");
    const queryKey = canonicalJson(query);
    if (cursor !== null) {
      const entry = this.cursors.get(cursor);
      if (!entry) return unavailable(query, "cursorUnavailable");
      const state = entry.state;
      if (
        state.actorScope !== actor.scope ||
        state.query !== queryKey ||
        !sameDirectory(state.directory, resolvedDirectory)
      )
        return unavailable(query, "cursorScopeChanged");
      clearTimeout(entry.timer);
      this.cursors.delete(cursor);
      return this.page(state, query);
    }
    if (query.kind !== "workingTree" && query.kind !== "branch" && query.kind !== "commit")
      return unavailable(query, "capturedComparisonUnsupported");
    const comparison = buildComparison(resolvedDirectory.path, resolvedDirectory.address, query);
    if ("reason" in comparison)
      return unavailable(query, comparison.reason, comparison.from, comparison.to);
    const paths = changedPaths(
      resolvedDirectory.path,
      comparison.pair.fromTree,
      comparison.pair.toTree,
    );
    if (!paths)
      return unavailable(query, "diffUnavailable", comparison.pair.from, comparison.pair.to);
    if (!paths.length)
      return v.parse(DiffResultSchema, {
        kind: "empty",
        from: comparison.pair.from,
        to: comparison.pair.to,
      });
    const scratch = mkdtempSync(join(tmpdir(), "kraka-diff-page-"));
    return this.page(
      {
        actorScope: actor.scope,
        query: queryKey,
        directory: resolvedDirectory,
        pair: comparison.pair,
        paths,
        pathIndex: 0,
        byteOffset: 0,
        scratch,
        patchPath: join(scratch, "patch"),
        currentSize: null,
        refs: null,
      },
      query,
    );
  }
  private page(state: CursorState, query: DiffRequest): DiffResult {
    const { from, to } = state.pair;
    let retained = false;
    try {
      const files: DiffFile[] = [],
        parts: string[] = [];
      let budget = logicalPatchBytes,
        unprintable = false;
      while (state.pathIndex < state.paths.length && budget > 0) {
        const path = state.paths[state.pathIndex];
        if (!path) break;
        const file = diffFile(path, state.directory.address);
        if (!file) return unavailable(query, "pathUnavailable", from, to);
        state.currentSize ??= preparePatch(state, path);
        if (state.currentSize === null) return unavailable(query, "diffUnavailable", from, to);
        const remaining = state.currentSize - state.byteOffset;
        const bytes = Buffer.alloc(Math.min(remaining, budget + 1)),
          fd = openSync(state.patchPath, "r");
        try {
          if (readSync(fd, bytes, 0, bytes.length, state.byteOffset) !== bytes.length)
            return unavailable(query, "shortPatch", from, to);
        } finally {
          closeSync(fd);
        }
        let take = Math.min(remaining, budget);
        if (take < remaining) while (take > 0 && ((bytes[take] ?? 0) & 192) === 128) take--;
        if (!take && remaining) break;
        files.push(file);
        try {
          parts.push(
            new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
              bytes.subarray(0, take),
            ),
          );
        } catch {
          unprintable = true;
          break;
        }
        state.byteOffset += take;
        budget -= take;
        if (state.byteOffset < state.currentSize) break;
        state.pathIndex++;
        state.byteOffset = 0;
        state.currentSize = null;
      }
      let next: string | null = null;
      if (!unprintable && state.pathIndex < state.paths.length) {
        if (!state.refs && !pin(state)) return unavailable(query, "retentionUnavailable", from, to);
        const cursor = crypto.randomUUID(),
          timer = setTimeout(() => this.expire(cursor), cursorRetentionMs);
        timer.unref();
        this.cursors.set(cursor, { state, timer });
        next = cursor;
        retained = true;
      }
      return v.parse(DiffResultSchema, {
        kind: "changed",
        from,
        to,
        files,
        patch: parts.join(""),
        truncated: unprintable || next !== null,
        next,
      });
    } catch {
      return unavailable(query, "diffUnavailable", from, to);
    } finally {
      if (!retained) release(state);
    }
  }
}
