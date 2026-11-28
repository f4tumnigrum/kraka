import { dirname, join } from "node:path";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { GitObjectIdSchema, type DirectoryBinding } from "@kraka/protocol";
import * as v from "valibot";
import {
  captureWorkspace,
  type CaptureState,
  type Boundary,
  type PublishedBoundary,
} from "./checkpoints";
import { gitAlternateDirectory, gitPath, gitProcessError } from "./git-process";
import type { DirectoryLease } from "./directory-lease";
import { physicalDirectory } from "./project-directory";

const sealSchema = v.strictObject({
  tree: GitObjectIdSchema,
  parent: v.nullable(GitObjectIdSchema),
  name: v.string(),
  email: v.string(),
  date: v.string(),
  message: v.string(),
  objects: v.string(),
});
export type CaptureSeal = v.InferOutput<typeof sealSchema>;
export const decodeSeal = (json: string) => v.parse(sealSchema, JSON.parse(json));
export type CaptureStage = "sealed" | "published" | "summary" | "settled";
export type CaptureHook = (
  stage: CaptureStage,
  boundary: Boundary,
  state: CaptureState,
) => Promise<void> | void;
export type RepositoryIdentity = NonNullable<ReturnType<typeof physicalDirectory>>;
export async function captureBoundary({
  captureKey: state,
  boundary,
  directoryBinding,
  lease,
  scratch,
  seal,
  recover,
  remember,
  source,
  bindSource,
  hook,
}: {
  captureKey: CaptureState;
  boundary: Boundary;
  directoryBinding: DirectoryBinding;
  lease: DirectoryLease;
  scratch: string;
  seal: CaptureSeal | null;
  recover: boolean;
  source: RepositoryIdentity | null;
  bindSource: (repo: RepositoryIdentity) => void;
  remember: (seal: CaptureSeal) => void;
  hook?: CaptureHook | undefined;
}): Promise<{ point: PublishedBoundary; repo: RepositoryIdentity }> {
  const plan = captureWorkspace(state);
  if (
    !plan ||
    state.kind !== boundary ||
    directoryBinding.directoryId !== lease.key.directoryId ||
    directoryBinding.generation !== lease.key.generation
  )
    throw Error("wrongCapture");
  const index = join(scratch, plan.privateIndexPath),
    objects = join(scratch, plan.privateObjectDirectory);
  const hooks = join(dirname(index), "hooks");
  try {
    mkdirSync(hooks, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw Error("index.prepare", { cause });
  }
  const deadline = lease.acquiredAt + 5000;
  function remaining() {
    const ms = Math.ceil(deadline - performance.now());
    if (ms <= 0)
      throw Error("captureTimeout", {
        cause: "Git boundary deadline elapsed after acquiring the directory lease",
      });
    return ms;
  }
  const run = (args: string[], env: Record<string, string> = {}, input?: Buffer) =>
    lease.git(
      [
        "-c",
        "core.hooksPath=" + gitPath(hooks),
        "-c",
        "core.fsync=loose-object,reference",
        "-c",
        "core.splitIndex=false",
        ...(process.platform === "win32" ? [] : ["-c", "core.fileMode=true"]),
        "-c",
        "core.logAllRefUpdates=false",
        "-c",
        "gc.auto=0",
        "--literal-pathspecs",
        ...args,
      ],
      env,
      input,
      remaining(),
    );
  const read = async (
    step: string,
    args: string[],
    env?: Record<string, string>,
    input?: Buffer,
  ) => {
    const r = await run(args, env, input).catch((error) => {
      if (error instanceof Error && error.message === "lease.git")
        throw Error(step, { cause: error.cause });
      throw error;
    });
    if (r.exitCode !== 0) {
      remaining();
      throw gitProcessError(step, r);
    }
    return r.stdout.toString().replace(/\r?\n$/, "");
  };
  const gitDir = await run(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (gitDir.exitCode !== 0)
    throw gitProcessError(
      gitDir.stderr.toString().includes("not a git repository")
        ? "noRepository"
        : "repository.rev-parse",
      gitDir,
    );
  const repo = physicalDirectory(gitDir.stdout.toString().trimEnd());
  if (!repo || (source && !Bun.deepEquals(source, repo))) throw Error("sourceRepositoryChanged");
  bindSource(repo);
  const commonObjects = join(repo.realPath, "objects");
  const env = {
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_INDEX_FILE: gitPath(index),
    GIT_OBJECT_DIRECTORY: gitPath(objects),
    GIT_ALTERNATE_OBJECT_DIRECTORIES: gitAlternateDirectory(commonObjects),
  };
  if (!seal) {
    if (recover) throw Error("boundaryNotSealed");
    try {
      rmSync(index, { force: true });
      mkdirSync(objects, { recursive: true, mode: 0o700 });
    } catch (cause) {
      throw Error("index.prepare", { cause });
    }
    const head = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    const parent =
      head.exitCode === 0 ? v.parse(GitObjectIdSchema, head.stdout.toString().trim()) : null;
    if (!parent) {
      const ref = await read("head.symbolic-ref", ["symbolic-ref", "--quiet", "HEAD"]);
      const exists = await run(["show-ref", "--exists", ref]);
      if (exists.exitCode !== 2) throw gitProcessError("headUnavailable", head);
    }
    await read("index.read-tree", parent ? ["read-tree", parent] : ["read-tree", "--empty"], env);
    const tracked = (await read("index.ls-files", ["ls-files", "--cached", "-z", "--", "."]))
      .split("\0")
      .filter(Boolean);
    await read("index.add", ["add", "-A", "--", "."], env);
    // A staged addition can since have become ignored. Capture its current disk bytes.
    const present = new Set(
      (await read("index.ls-files", ["ls-files", "--cached", "-z", "--", "."], env)).split("\0"),
    );
    const extra = tracked.filter(
      (path) => !present.has(path) && lstatSync(join(lease.path, path), { throwIfNoEntry: false }),
    );
    if (extra.length)
      await read(
        "index.add-tracked",
        ["add", "-f", "--pathspec-from-file=-", "--pathspec-file-nul"],
        env,
        Buffer.from(extra.join("\0") + "\0"),
      );
    const tree = v.parse(GitObjectIdSchema, await read("objects.write-tree", ["write-tree"], env));
    seal = {
      tree,
      parent,
      objects,
      name: "kraka",
      email: "checkpoint@kraka.invalid",
      date: "@" + Math.floor(Date.now() / 1000) + " +0000",
      message: "kraka " + state.key.id + " " + boundary,
    };
    if (lease.revalidate(lease.key) !== "current") throw Error("lease.revalidate");
    const checked = await run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
    if ((checked.exitCode === 0 ? checked.stdout.toString().trim() : null) !== parent)
      throw Error("headChanged");
    remember(seal);
    await hook?.("sealed", boundary, state);
  }
  try {
    mkdirSync(objects, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw Error("objects.prepare", { cause });
  }
  if (seal.objects !== objects || seal.message !== "kraka " + state.key.id + " " + boundary)
    throw Error("sealMismatch");
  const meta = {
    GIT_AUTHOR_NAME: seal.name,
    GIT_COMMITTER_NAME: seal.name,
    GIT_AUTHOR_EMAIL: seal.email,
    GIT_COMMITTER_EMAIL: seal.email,
    GIT_AUTHOR_DATE: seal.date,
    GIT_COMMITTER_DATE: seal.date,
  };
  const args = [
    "-c",
    "commit.gpgSign=false",
    "-c",
    "i18n.commitEncoding=UTF-8",
    "commit-tree",
    seal.tree,
    ...(seal.parent ? ["-p", seal.parent] : []),
    "-m",
    seal.message,
  ];
  const commit = v.parse(
    GitObjectIdSchema,
    await read("objects.commit-tree", args, { ...env, ...meta }),
  );
  if (
    lease.revalidate(lease.key) !== "current" ||
    !Bun.deepEquals(
      repo,
      physicalDirectory(
        await read("repository.rev-parse", [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ]),
      ),
    )
  )
    throw Error("lease.revalidate");
  const point = { ref: plan.ref, commit, tree: seal.tree };
  const commonDir = "--git-dir=" + gitPath(repo.realPath);
  const existing = recover
    ? await lease.git([commonDir, "rev-parse", "--verify", "--quiet", plan.ref])
    : null;
  if (existing?.exitCode === 0 && existing.stdout.toString().trim() !== commit)
    throw Error("idConflict");
  let publicationError: Error | undefined;
  try {
    if (existing?.exitCode !== 0) {
      await lease.installObjects({
        repository: repo.realPath,
        env,
        commit,
        parent: seal.parent,
        timeout: remaining(),
      });
      await read("objects.fsck", [
        commonDir,
        "fsck",
        "--connectivity-only",
        "--no-reflogs",
        "--no-dangling",
        commit,
      ]);
      const published = await run([
        commonDir,
        "update-ref",
        plan.ref,
        commit,
        "0".repeat(commit.length),
      ]);
      if (published.exitCode !== 0) {
        remaining();
        publicationError = gitProcessError("ref.update-ref", published);
      }
    }
  } catch (error) {
    if (!(error instanceof Error) || error.message !== "captureTimeout") throw error;
    publicationError = error;
  }
  // A timeout may race with the ref rename. Reconcile only this exact publication.
  const verify = await lease.git([commonDir, "rev-parse", "--verify", plan.ref]);
  const tree = await lease.git([commonDir, "rev-parse", "--verify", plan.ref + "^{tree}"]);
  if (verify.exitCode === 0 && verify.stdout.toString().trim() !== commit)
    throw Error("idConflict", { cause: "ref.verify: published commit differs from sealed commit" });
  if (verify.exitCode !== 0) throw publicationError ?? gitProcessError("ref.verify", verify);
  if (tree.exitCode !== 0) throw gitProcessError("tree.verify", tree);
  if (tree.stdout.toString().trim() !== point.tree)
    throw Error("tree.verify", { cause: "Published tree differs from sealed tree" });
  await hook?.("published", boundary, state);
  return { point, repo };
}
