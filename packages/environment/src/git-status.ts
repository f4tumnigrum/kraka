import { realpathSync, statSync } from "node:fs";
import {
  GitGranularitySchema,
  GitObjectIdSchema,
  WorkspaceTargetSchema,
  WorkspaceRelativePathSchema,
  type GitStatus,
} from "@kraka/protocol";
import * as v from "valibot";
import { RemoteStatusCache, probeRemote, type RemoteProbe } from "./git-remote";
import { watchGitDirectory } from "./git-directory-watch";
import { runGit } from "./git-process";

export type GitGranularity = v.InferOutput<typeof GitGranularitySchema>;
export type WorkspaceTarget = v.InferOutput<typeof WorkspaceTargetSchema>;
type ProcessObserver = (directory: string, granularity: GitGranularity) => void;
type StatusInput = {
  target: WorkspaceTarget;
  granularity: GitGranularity;
  authorizedDirectory: string | null;
  sequence: number;
  onGitProcess?: ProcessObserver;
};
type StatusEntry = {
  path: string;
  status: string;
  untracked: boolean;
};
type CacheEntry = {
  status: GitStatus;
  fingerprint: string;
  observedAt: number;
  directory: string | null;
  local: GitStatus;
};

const statusCacheMs = 1_000;
const statusRetentionMs = 10_000;
const maxStatusEntries = 2_048;
const processCounts = new Map<string, number>();

function runStatusGit(
  directory: string,
  args: string[],
  granularity: GitGranularity,
  observer?: ProcessObserver,
) {
  const result = runGit(directory, args, { timeout: 5000 });
  recordStart(directory, granularity, observer);
  return result;
}
function recordStart(directory: string, granularity: GitGranularity, observer?: ProcessObserver) {
  observer?.(directory, granularity);
  const key = JSON.stringify([directory, granularity]);
  processCounts.set(key, (processCounts.get(key) ?? 0) + 1);
  if (processCounts.size > 4096) {
    const oldest = processCounts.keys().next().value;
    if (oldest !== undefined) processCounts.delete(oldest);
  }
}

export function gitStatusProcessCount(directory: string, granularity: GitGranularity) {
  return processCounts.get(JSON.stringify([directory, granularity])) ?? 0;
}

function parseStatus(output: string) {
  const values = output.split("\0").filter(Boolean);
  const fields = new Map<string, string>();
  let firstEntry = values.findIndex((line) => !line.startsWith("# "));
  if (firstEntry < 0) firstEntry = values.length;
  for (const line of values.slice(0, firstEntry)) {
    const match = /^# ([a-z.]+) (.*)$/.exec(line);
    if (match?.[1] && match[2] !== undefined) fields.set(match[1], match[2]);
  }
  const entries: StatusEntry[] = [];
  for (let index = firstEntry; index < values.length; index++) {
    const record = values[index] ?? "";
    if (record.startsWith("? ")) {
      entries.push({
        path: record.slice(2),
        status: "??",
        untracked: true,
      });
      continue;
    }
    const kind = record.slice(0, 1);
    const fieldCount = kind === "1" ? 9 : kind === "2" ? 10 : kind === "u" ? 11 : 0;
    if (!fieldCount) continue;
    const columns = record.split(" ");
    const status = columns[1];
    const path = columns.slice(fieldCount - 1).join(" ");
    if (!status || path === undefined) continue;
    if (kind === "2") index++;
    entries.push({ path, status, untracked: false });
  }
  return { fields, entries };
}

function validPath(path: string) {
  const parsed = v.safeParse(WorkspaceRelativePathSchema, path);
  return parsed.success ? parsed.output : null;
}

function headFrom(fields: Map<string, string>) {
  const name = fields.get("branch.head");
  const oid = fields.get("branch.oid");
  if (name === "(detached)" && oid) {
    const parsed = v.safeParse(GitObjectIdSchema, oid);
    if (parsed.success) return { kind: "detached" as const, tip: parsed.output };
  }
  if (name && name !== "(unknown)") {
    const parsed = oid && oid !== "(initial)" ? v.safeParse(GitObjectIdSchema, oid) : null;
    return {
      kind: "branch" as const,
      name,
      tip: parsed?.success ? parsed.output : null,
    };
  }
  return null;
}

function pathChanges(entries: StatusEntry[]) {
  type DetailedStatus = Extract<GitStatus, { kind: "detailed" }>;
  const staged: DetailedStatus["staged"] = [];
  const unstaged: DetailedStatus["unstaged"] = [];
  const untracked: string[] = [];
  for (const entry of entries) {
    const path = validPath(entry.path);
    if (!path) return null;
    if (entry.untracked) {
      untracked.push(path);
      continue;
    }
    if (entry.status[0] !== ".")
      staged.push({ path, status: entry.status, insertions: null, deletions: null });
    if (entry.status[1] !== ".")
      unstaged.push({ path, status: entry.status, insertions: null, deletions: null });
  }
  staged.sort((a, b) => a.path.localeCompare(b.path));
  unstaged.sort((a, b) => a.path.localeCompare(b.path));
  untracked.sort((a, b) => a.localeCompare(b));
  return { staged, unstaged, untracked };
}

function relativePath(prefix: string, path: string) {
  const value =
    prefix && path.startsWith(prefix) ? path.slice(prefix.length) : prefix ? null : path;
  return value ? validPath(value) : null;
}

function lineCounts(
  directory: string,
  cached: boolean,
  rows: Extract<GitStatus, { kind: "detailed" }>["staged"],
  observe?: ProcessObserver,
) {
  if (!rows.length) return;
  const result = runStatusGit(
    directory,
    [
      "diff",
      ...(cached ? ["--cached"] : []),
      "--relative",
      "--numstat",
      "-z",
      "--no-renames",
      "--no-textconv",
      "--no-ext-diff",
      "--",
      ".",
    ],
    "detailed",
    observe,
  );
  if (result.exitCode !== 0) return;
  const paths = new Map(rows.map((row) => [row.path, row]));
  for (const record of result.stdout.toString().split("\0")) {
    const m = /^(\d+)\t(\d+)\t([\s\S]+)$/.exec(record);
    const row = m?.[3] && paths.get(m[3]);
    if (m && row) {
      row.insertions = Number(m[1]);
      row.deletions = Number(m[2]);
    }
  }
}

/** Read only inside a caller-resolved physical binding. An invalid binding is never replaced by another path. */
export function readGitStatus({
  target,
  granularity,
  authorizedDirectory,
  sequence,
  onGitProcess,
}: StatusInput): GitStatus {
  const invalidated = (): GitStatus => ({ kind: "invalidated", target, sequence, granularity });
  if (!authorizedDirectory) return invalidated();
  let directory: string;
  try {
    directory = realpathSync.native(authorizedDirectory);
    if (!statSync(directory).isDirectory()) return invalidated();
  } catch {
    return invalidated();
  }
  const result = runStatusGit(
    directory,
    [
      "status",
      "--porcelain=v2",
      "--branch",
      "--no-ahead-behind",
      granularity === "branch" ? "--untracked-files=no" : "--untracked-files=all",
      "-z",
      "--",
      ".",
    ],
    granularity,
    onGitProcess,
  );
  if (result.exitCode !== 0) {
    if (result.stderr.toString().includes("not a git repository"))
      return { kind: "notRepository", target, sequence, granularity };
    return invalidated();
  }
  const { fields, entries } = parseStatus(result.stdout.toString());
  const head = headFrom(fields);
  if (!head) return invalidated();
  if (granularity === "branch") return { kind: "branch", target, sequence, head };
  const prefix = runStatusGit(directory, ["rev-parse", "--show-prefix"], granularity, onGitProcess);
  if (prefix.exitCode !== 0) return invalidated();
  const pathPrefix = prefix.stdout.toString().replace(/\r?\n$/, "");
  const scopedEntries: StatusEntry[] = [];
  for (const entry of entries) {
    const path = relativePath(pathPrefix, entry.path);
    if (!path) return invalidated();
    scopedEntries.push({ ...entry, path });
  }
  const changes = pathChanges(scopedEntries);
  if (!changes) return invalidated();
  const { staged, unstaged, untracked } = changes;
  lineCounts(directory, true, staged, onGitProcess);
  lineCounts(directory, false, unstaged, onGitProcess);
  return {
    kind: "detailed",
    target,
    sequence,
    head,
    staged,
    unstaged,
    untracked,
    remote: { kind: "unverified" },
  };
}

function statusFingerprint(status: GitStatus) {
  const { target: _target, sequence: _sequence, ...observation } = status;
  return JSON.stringify(observation);
}

function cacheKey({
  environmentId,
  target,
}: {
  environmentId: string;
  target: WorkspaceTarget;
  granularity: GitGranularity;
}) {
  return JSON.stringify([environmentId, target.directoryId, target.generation]);
}

/** Shared cache for live reads and subscriptions. The fingerprint excludes the authorized target. */
export class GitStatusCache {
  private readonly caches = new Map<GitGranularity, Map<string, CacheEntry>>([
    ["branch", new Map()],
    ["detailed", new Map()],
  ]);
  private readonly directories = new Map<
    string,
    { path: string; stop: () => void; users: number; idle: ReturnType<typeof setTimeout> | null }
  >();
  private readonly remote: RemoteStatusCache;
  constructor(
    private readonly now = () => performance.now(),
    private readonly onGitProcess?: ProcessObserver,
    probe: RemoteProbe = probeRemote,
  ) {
    this.remote = new RemoteStatusCache(now, probe);
  }
  private forget(key: string) {
    const dir = this.directories.get(key);
    if (dir) {
      dir.stop();
      if (dir.idle) clearTimeout(dir.idle);
    }
    this.directories.delete(key);
    for (const cache of this.caches.values()) cache.delete(key);
    this.remote.forget(key);
  }
  private idle(key: string) {
    const dir = this.directories.get(key);
    if (!dir || dir.users) return;
    if (dir.idle) clearTimeout(dir.idle);
    dir.idle = setTimeout(() => this.forget(key), statusRetentionMs);
    dir.idle.unref();
  }
  private directory(key: string, path: string) {
    const existing = this.directories.get(key);
    if (existing?.path === path) return existing;
    if (existing) this.forget(key);
    const dir = {
      path,
      users: 0,
      idle: null as ReturnType<typeof setTimeout> | null,
      stop: watchGitDirectory(path, () => {
        for (const cache of this.caches.values()) {
          const entry = cache.get(key);
          if (entry) entry.observedAt = -Infinity;
        }
      }),
    };
    this.directories.set(key, dir);
    if (this.directories.size > 4096) {
      const old = [...this.directories].find(([k, d]) => k !== key && d.users === 0);
      if (old) this.forget(old[0]);
    }
    return dir;
  }
  read(input: {
    environmentId: string;
    target: WorkspaceTarget;
    granularity: GitGranularity;
    authorizedDirectory: string | null;
    onGitProcess?: ProcessObserver;
  }): GitStatus {
    const key = cacheKey(input),
      cache = this.caches.get(input.granularity);
    if (!cache) throw Error("Unsupported Git granularity");
    if (input.authorizedDirectory) {
      this.directory(key, input.authorizedDirectory);
      this.idle(key);
    }
    const entry = cache.get(key),
      now = this.now(),
      observe = input.onGitProcess ?? this.onGitProcess;
    const hit =
      entry &&
      entry.directory === input.authorizedDirectory &&
      now - entry.observedAt < statusCacheMs;
    const local = hit
      ? entry.local
      : readGitStatus({ ...input, sequence: 1, ...(observe ? { onGitProcess: observe } : {}) });
    if (!input.authorizedDirectory) this.remote.forget(key);
    let observation = local;
    if (local.kind === "detailed" && input.authorizedDirectory) {
      const path = input.authorizedDirectory;
      const remote = this.remote.read(key, path, local.head, () =>
        recordStart(path, "detailed", observe),
      );
      observation = { ...local, remote };
    }
    const fingerprint = statusFingerprint(observation),
      sequence = entry ? entry.status.sequence + Number(entry.fingerprint !== fingerprint) : 1;
    const status = { ...observation, target: input.target, sequence };
    cache.delete(key);
    cache.set(key, {
      status,
      local,
      fingerprint,
      observedAt: hit ? entry.observedAt : now,
      directory: input.authorizedDirectory,
    });
    if (cache.size > maxStatusEntries) {
      const old = cache.keys().next().value;
      if (old !== undefined) cache.delete(old);
    }
    return status;
  }
  watch(
    input: { environmentId: string; target: WorkspaceTarget; granularity: GitGranularity },
    path: string | null,
  ) {
    if (!path) return () => {};
    const key = cacheKey(input),
      dir = this.directory(key, path);
    dir.users++;
    if (dir.idle) clearTimeout(dir.idle);
    return () => {
      if (this.directories.get(key) !== dir) return;
      dir.users--;
      this.idle(key);
    };
  }
  close() {
    for (const key of this.directories.keys()) this.forget(key);
  }
}
