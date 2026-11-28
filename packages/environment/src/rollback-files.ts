import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import {
  WorkspaceRelativePathSchema,
  type RollbackTarget,
  type CheckpointCapture,
} from "@kraka/protocol";
import { gitRepositoryIdentity, runGit } from "./git-process";
import { privateHooks, privateDirectory } from "./private-git";
import type { DirectoryLease } from "./directory-lease";
import type { FirstSendStore } from "./first-send-store";
import { captureSource, storedCheckpointRef } from "./capture-store";

const entry = v.strictObject({
  path: WorkspaceRelativePathSchema,
  prior: v.nullable(v.string()),
  target: v.nullable(v.string()),
  blob: v.nullable(v.string()),
  mode: v.string(),
  index: v.string(),
  headIndex: v.string(),
});
const schema = v.strictObject({
  commit: v.string(),
  head: v.string(),
  branch: v.string(),
  paths: v.array(entry),
  protected: v.array(v.string()),
});
export type RestorePlan = v.InferOutput<typeof schema>;
export const parseRestorePlan = (raw: string) => v.parse(schema, JSON.parse(raw));
export class RestoreFailure extends Error {
  constructor(
    readonly disposition: "failed" | "unknown",
    reason: string,
  ) {
    super(reason);
  }
}
const uncertain = (reason: string) => new RestoreFailure("unknown", reason);
function safePath(root: string, path: string) {
  v.parse(WorkspaceRelativePathSchema, path);
  const parts = path.split("/");
  if (
    parts.some(
      (part) =>
        /^\.git(?:$|[ .])/i.test(part) || (process.platform === "win32" && /[:\\]/.test(part)),
    )
  )
    throw uncertain("unsafePath");
  let parent = root;
  for (const part of parts.slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent, { throwIfNoEntry: false });
    if (stat && !stat.isDirectory()) throw uncertain("pathChanged");
  }
  return join(root, ...parts);
}
function fingerprint(mode: string, bytes: Buffer) {
  return mode + ":" + createHash("sha256").update(bytes).digest("hex");
}
function disk(path: string) {
  const s = lstatSync(path, { throwIfNoEntry: false });
  if (!s) return null;
  if (s.isSymbolicLink()) return fingerprint("120000", readlinkSync(path, { encoding: "buffer" }));
  if (!s.isFile()) throw uncertain("pathChanged");
  return fingerprint(
    process.platform !== "win32" && s.mode & 0o111 ? "100755" : "100644",
    readFileSync(path),
  );
}
function records(buffer: Buffer) {
  return new TextDecoder("utf-8", { fatal: true }).decode(buffer).split("\0").filter(Boolean);
}
function entries(buffer: Buffer) {
  return new Map(
    records(buffer).map((row) => {
      const tab = row.indexOf("\t");
      if (tab < 0) throw uncertain("invalidIndex");
      const meta = row.slice(0, tab).split(" "),
        path = v.parse(WorkspaceRelativePathSchema, row.slice(tab + 1));
      if (meta.length !== 3 || !["100644", "100755", "120000"].includes(meta[0]!))
        throw uncertain("unsupportedEntry");
      const stage = meta[2] === "0",
        oid = stage ? meta[1] : meta[2];
      if (!stage && meta[1] !== "blob") throw uncertain("unmergedIndex");
      return [path, { mode: meta[0]!, oid: oid!, index: meta[0] + " " + oid }] as const;
    }),
  );
}
export function restoreWorkspace(
  store: FirstSendStore,
  lease: DirectoryLease,
  target: RollbackTarget,
  capture: CheckpointCapture,
) {
  const root = lease.path,
    config = [
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      privateHooks(store.gitPaths.state),
    ];
  const run = (args: string[]) => runGit(root, [...config, ...args]);
  const read = (...args: string[]) => {
    const r = run(args);
    if (r.exitCode !== 0) throw Error("gitReadFailed");
    return r.stdout;
  };
  const line = (...args: string[]) =>
    read(...args)
      .toString()
      .replace(/\r?\n$/, "");
  const source = store.db
    .query<{ repo: string }, [string]>(
      "SELECT s.repo FROM round_captures c JOIN capture_sources s ON s.id=c.source WHERE c.id=?",
    )
    .get(capture.id);
  if (!source?.repo || capture.result.kind !== "ready" || !capture.result.comparison)
    throw Error("checkpointUnavailable");
  const original = captureSource(source.repo);
  const ref = storedCheckpointRef(
    root,
    {
      threadId: target.threadId,
      id: target.captureId,
      environmentId: store.writer.environmentId,
      writer: store.gitPaths.writer,
    },
    target.boundary,
    !original.writer,
  );
  const commit = capture.result.comparison[target.boundary];
  function verify() {
    if (
      lease.revalidate(lease.key) !== "current" ||
      (original.writer && original.writer !== store.gitPaths.writer) ||
      !Bun.deepEquals(original.repo, gitRepositoryIdentity(root)) ||
      line("rev-parse", "--verify", ref) !== commit
    )
      throw uncertain("checkpointChanged");
  }
  verify();
  const prefix = line("rev-parse", "--show-prefix");
  const blob = (path: string, oid: string, mode: string) =>
    mode === "120000"
      ? read("cat-file", "blob", oid)
      : read("cat-file", "--filters", "--path=" + prefix + path, oid);
  function snapshot() {
    verify();
    const headResult = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if (headResult.exitCode !== 0 && headResult.exitCode !== 1) throw Error("headUnavailable");
    const head = headResult.stdout.toString().trim();
    const branchResult = run(["symbolic-ref", "--quiet", "HEAD"]);
    if (branchResult.exitCode !== 0 && branchResult.exitCode !== 1) throw Error("headUnavailable");
    const branch = branchResult.stdout.toString().trim();
    if (!head && !branch) throw Error("headUnavailable");
    const targetTree = entries(read("ls-tree", "-rz", commit, "--", "."));
    const headTree = head
      ? entries(read("ls-tree", "-rz", head, "--", "."))
      : new Map<string, { index: string }>();
    const index = entries(read("ls-files", "--stage", "-z", "--", "."));
    const ignored = records(
      read("ls-files", "--others", "--ignored", "--exclude-standard", "-z", "--", "."),
    ).sort();
    const names = new Set([
      ...targetTree.keys(),
      ...headTree.keys(),
      ...index.keys(),
      ...records(read("ls-files", "--others", "--exclude-standard", "-z", "--", ".")),
    ]);
    const paths = Array.from(names)
      .sort()
      .flatMap((path) => {
        if (ignored.includes(path)) return [];
        const item = targetTree.get(path);
        const mode = item?.mode ?? "";
        const bytes = item ? blob(path, item.oid, mode) : null;
        const target = bytes
          ? fingerprint(process.platform === "win32" && mode === "100755" ? "100644" : mode, bytes)
          : null;
        return [
          {
            path,
            prior: disk(safePath(root, path)),
            target,
            blob: item?.oid ?? null,
            mode,
            index: index.get(path)?.index ?? "",
            headIndex: headTree.get(path)?.index ?? "",
          },
        ];
      });
    return { head, branch, commit, paths, protected: ignored };
  }
  function preflight() {
    verify();
    const indexPath = line("rev-parse", "--path-format=absolute", "--git-path", "index");
    if (existsSync(indexPath + ".lock")) throw new RestoreFailure("failed", "indexLocked");
  }
  function validate(plan: RestorePlan) {
    const now = snapshot(),
      byPath = new Map(now.paths.map((p) => [p.path, p]));
    if (
      now.head !== plan.head ||
      now.branch !== plan.branch ||
      plan.commit !== commit ||
      !Bun.deepEquals(now.protected, plan.protected)
    )
      throw uncertain("checkoutChanged");
    const names = new Set(plan.paths.map((p) => p.path));
    if (now.paths.some((p) => !names.has(p.path))) throw uncertain("checkoutChanged");
    for (const item of plan.paths) {
      const current = byPath.get(item.path);
      const content = current?.prior ?? null,
        index = current?.index ?? "";
      if (
        (content !== item.prior && content !== item.target) ||
        (index !== item.index && index !== item.headIndex) ||
        (current?.target ?? null) !== item.target
      )
        throw uncertain("checkoutChanged");
    }
    return now;
  }
  async function apply(
    plan: RestorePlan,
    exclusive: () => boolean,
    attempted: (path: string) => void,
  ) {
    validate(plan);
    preflight();
    if (!exclusive()) throw new RestoreFailure("failed", "sharedWorkspace");
    const scratch = join(store.gitPaths.state, "rollback-scratch");
    privateDirectory(scratch);
    const dir = mkdtempSync(join(scratch, "replace-"));
    let wrote = false;
    try {
      for (const item of plan.paths) {
        const path = safePath(root, item.path),
          prior = disk(path);
        if (prior === item.target) continue;
        if (prior !== item.prior) throw uncertain("checkoutChanged");
        const temp = join(dir, "next");
        if (item.blob) {
          const bytes = blob(item.path, item.blob, item.mode);
          if (item.mode === "120000") symlinkSync(bytes.toString(), temp);
          else {
            writeFileSync(temp, bytes, { flag: "wx" });
            chmodSync(temp, item.mode === "100755" ? 0o755 : 0o644);
          }
        }
        attempted(item.path);
        if (item.blob) {
          mkdirSync(dirname(path), { recursive: true });
          renameSync(temp, path);
        } else unlinkSync(path);
        wrote = true;
      }
      const updates = plan.paths.filter((p) => p.index !== p.headIndex);
      if (updates.length) {
        if (!exclusive()) throw uncertain("sharedWorkspace");
        const args = plan.head
          ? ["reset", "-q", plan.head, "--pathspec-from-file=-", "--pathspec-file-nul"]
          : [
              "rm",
              "--cached",
              "--ignore-unmatch",
              "-q",
              "-f",
              "--pathspec-from-file=-",
              "--pathspec-file-nul",
            ];
        const r = await lease.git(
          [...config, ...args],
          {},
          Buffer.from(updates.map((p) => p.path + "\0").join("")),
        );
        if (r.exitCode !== 0) throw Error("indexWriteFailed");
      }
      const final = validate(plan),
        byPath = new Map(final.paths.map((p) => [p.path, p]));
      if (
        plan.paths.some(
          (p) =>
            (byPath.get(p.path)?.prior ?? null) !== p.target ||
            (byPath.get(p.path)?.index ?? "") !== p.headIndex,
        )
      )
        throw uncertain("restoreUnverified");
    } catch (e) {
      if (e instanceof RestoreFailure) throw e;
      throw new RestoreFailure(wrote ? "unknown" : "failed", "fileIO");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return { preflight, snapshot, validate, apply };
}
