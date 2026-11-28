import { Database } from "bun:sqlite";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, toNamespacedPath } from "node:path";
import { createHash } from "node:crypto";
import * as v from "valibot";
import { GitObjectIdSchema, type DirectoryBinding, type EnvironmentId } from "@kraka/protocol";
import { physicalDirectory } from "./project-directory";
import {
  runGit,
  gitCheckoutArgs,
  gitPath,
  gitProcessError,
  type GitProcessResult,
} from "./git-process";
import { worktreeWorkerCommand } from "./worktree-worker";

export type LeaseKey = Pick<DirectoryBinding, "directoryId" | "generation"> & {
  environmentId: EnvironmentId;
  operationId: string;
};
type Physical = NonNullable<ReturnType<typeof physicalDirectory>>;
const taskSchema = v.object({
  kind: v.literal("directoryLease"),
  state: v.string(),
  directoryId: v.string(),
  path: v.string(),
  identity: v.string(),
});
const gitRequest = v.object({
  args: v.array(v.string()),
  env: v.record(v.string(), v.string()),
  input: v.string(),
  timeout: v.number(),
});
const transfer = v.object({
  checkout: v.strictObject({ gitDir: v.string(), workTree: v.string() }),
  commit: GitObjectIdSchema,
  parent: v.nullable(GitObjectIdSchema),
  env: v.record(v.string(), v.string()),
  timeout: v.number(),
});
function installObjects(path: string, req: v.InferOutput<typeof transfer>) {
  const index = req.env.GIT_INDEX_FILE;
  if (!index) throw Error("Missing private index");
  const scratch = dirname(index),
    pack = join(scratch, "capture.pack");
  const config = [
    ...gitCheckoutArgs(req.checkout),
    "-c",
    "core.hooksPath=" + gitPath(join(scratch, "hooks")),
    "-c",
    "core.fsync=loose-object,reference",
  ];
  const until = performance.now() + req.timeout;
  const packFile = Bun.file(toNamespacedPath(pack));
  // BunFile redirection does not truncate a prior pack on replay.
  let step = "objects.pack-objects";
  try {
    writeFileSync(pack, Buffer.alloc(0), { mode: 0o600 });
    const selected = req.commit + "\n" + (req.parent ? "^" + req.parent + "\n" : "");
    const packed = runGit(path, [...config, "pack-objects", "--stdout", "--local", "--revs"], {
      env: req.env,
      input: Buffer.from(selected),
      outputFile: packFile,
      timeout: req.timeout,
    });
    if (packed.exitCode !== 0) {
      const error = gitProcessError(step, packed);
      if (performance.now() >= until) throw Error("captureTimeout", { cause: error.cause });
      throw error;
    }
    step = "objects.unpack-objects";
    const ms = Math.ceil(until - performance.now());
    if (ms <= 0) throw Error("captureTimeout", { cause: step });
    const unpacked = runGit(path, [...config, "unpack-objects", "-r"], {
      input: packFile,
      timeout: ms,
    });
    if (unpacked.exitCode !== 0) {
      const error = gitProcessError(step, unpacked);
      if (performance.now() >= until) throw Error("captureTimeout", { cause: error.cause });
      throw error;
    }
    return unpacked;
  } catch (error) {
    if (error instanceof Error && (error.message === step || error.message === "captureTimeout"))
      throw error;
    throw Error(step, { cause: error });
  }
}
const requestSchema = v.union([gitRequest, transfer]);
const replySchema = v.variant("kind", [
  v.object({ kind: v.literal("acquired"), at: v.number() }),
  v.object({ kind: v.literal("failure"), reason: v.string(), detail: v.string() }),
  v.object({
    kind: v.literal("git"),
    exitCode: v.nullable(v.number()),
    stdout: v.string(),
    stderr: v.string(),
  }),
]);

// The helper keeps the OS locks until its last synchronous Git child has exited,
// even when killing the daemon closes the IPC channel mid-command.
export async function runDirectoryWriter(raw: unknown) {
  const task = v.parse(taskSchema, raw);
  const locks: Database[] = [];
  const folder = join(task.state, "worktree-writers");
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  try {
    for (const name of [
      "physical-" + createHash("sha256").update(task.identity).digest("hex"),
      task.directoryId,
    ]) {
      if (!/^[A-Za-z0-9-]+$/.test(name)) throw Error("Invalid directory lease");
      const db = new Database(join(folder, name + ".sqlite"), { create: true });
      locks.push(db);
      db.run("PRAGMA busy_timeout=30000");
      db.run("BEGIN EXCLUSIVE");
    }
    if (!process.connected) return;
    const end = Promise.withResolvers<void>();
    const handle = (raw: unknown) => {
      const req = v.parse(requestSchema, raw);
      if (physicalDirectory(task.path)?.identity !== task.identity)
        throw Error("Directory replaced");
      const r =
        "commit" in req
          ? installObjects(task.path, req)
          : runGit(task.path, req.args, {
              env: req.env,
              ...(req.input ? { input: Buffer.from(req.input, "base64") } : {}),
              timeout: req.timeout,
            });
      process.send?.({
        kind: "git",
        exitCode: r.exitCode,
        stdout: r.stdout.toString("base64"),
        stderr: r.stderr.toString("base64"),
      });
    };
    const respond = (raw: unknown) => {
      try {
        handle(raw);
      } catch (error) {
        process.send?.({
          kind: "failure",
          reason:
            error instanceof Error &&
            ["objects.pack-objects", "objects.unpack-objects", "captureTimeout"].includes(
              error.message,
            )
              ? error.message
              : "lease.git",
          detail: String(error instanceof Error ? (error.cause ?? error.message) : error).slice(
            -2048,
          ),
        });
      }
    };
    process.on("message", respond);
    process.once("disconnect", end.resolve);
    process.send?.({ kind: "acquired", at: performance.timeOrigin + performance.now() });
    await end.promise;
    process.off("message", respond);
  } finally {
    for (const db of locks.reverse()) db.close(true);
  }
}

export interface DirectoryLease {
  installObjects: (request: v.InferOutput<typeof transfer>) => Promise<void>;
  key: LeaseKey;
  path: string;
  acquiredAt: number;
  revalidate: (key: LeaseKey) => "current" | "lost";
  git: (
    args: string[],
    env?: Record<string, string>,
    input?: Buffer,
    timeout?: number,
  ) => Promise<GitProcessResult>;
}

export class DirectoryWriters {
  private readonly writers = new Map<string, Promise<void>>();
  constructor(
    private readonly state: string,
    private readonly resolve: (key: LeaseKey) => Physical | null,
  ) {}
  async withDirectoryLease<T>(
    key: LeaseKey,
    callback: (lease: DirectoryLease) => Promise<T>,
    signal?: AbortSignal,
  ) {
    const physical = this.resolve(key);
    if (!physical) throw Error("lease.acquire", { cause: "Directory binding unavailable" });
    const previous = this.writers.get(physical.identity) ?? Promise.resolve();
    const done = Promise.withResolvers<void>();
    const tail = previous.then(() => done.promise);
    this.writers.set(physical.identity, tail);
    let acquired = false;
    const cancelled = Promise.withResolvers<never>();
    const abort = () => cancelled.reject(Error("captureCancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    try {
      signal?.throwIfAborted();
      await Promise.race([previous, cancelled.promise]);
      const task = {
        kind: "directoryLease",
        path: physical.realPath,
        identity: physical.identity,
        state: this.state,
        directoryId: key.directoryId,
      };
      let pending = Promise.withResolvers<v.InferOutput<typeof replySchema>>();
      const launch = () =>
        Bun.spawn(
          [
            process.execPath,
            ...(Bun.isStandaloneExecutable ? [] : [Bun.main]),
            worktreeWorkerCommand,
            JSON.stringify(task),
          ],
          {
            stdin: "ignore",
            stdout: "ignore",
            stderr: "pipe",
            ipc(raw) {
              const r = v.safeParse(replySchema, raw);
              if (r.success) pending.resolve(r.output);
              else pending.reject(Error("Invalid directory writer reply"));
            },
          },
        );
      let child: ReturnType<typeof launch>;
      try {
        child = launch();
      } catch (cause) {
        throw Error("lease.acquire", { cause });
      }
      const error = new Response(child.stderr).text();
      void child.exited.then(async (code) =>
        pending.reject(
          Error(acquired ? "lease.workerExit" : "lease.acquire", {
            cause: "Directory writer exit " + code + ": " + (await error).slice(-2048),
          }),
        ),
      );
      try {
        const held = await Promise.race([pending.promise, cancelled.promise]);
        if (held.kind !== "acquired") throw Error("lease.acquire");
        acquired = true;
        const revalidate = (probe: LeaseKey): "current" | "lost" =>
          acquired &&
          !signal?.aborted &&
          Bun.deepEquals(key, probe) &&
          Bun.deepEquals(physical, this.resolve(key)) &&
          child.exitCode === null &&
          child.signalCode === null
            ? "current"
            : "lost";
        if (revalidate(key) !== "current") throw Error("lease.revalidate");
        let busy = false;
        const send = async (message: v.InferOutput<typeof requestSchema>) => {
          if (busy || !acquired || signal?.aborted) throw Error("directoryLost");
          busy = true;
          try {
            pending = Promise.withResolvers();
            child.send(message);
            const r = await pending.promise;
            if (r.kind === "failure") throw Error(r.reason, { cause: r.detail });
            if (r.kind !== "git") throw Error("invalidWriterReply");
            return {
              exitCode: r.exitCode,
              stdout: Buffer.from(r.stdout, "base64"),
              stderr: Buffer.from(r.stderr, "base64"),
            };
          } finally {
            busy = false;
          }
        };
        return await callback({
          key,
          path: physical.realPath,
          acquiredAt: held.at - performance.timeOrigin,
          revalidate,
          git: (args, env = {}, input = Buffer.alloc(0), timeout = 5000) =>
            send({ args, env, input: input.toString("base64"), timeout }),
          installObjects: async (request) => {
            await send(request);
          },
        });
      } finally {
        if (!acquired && child.exitCode === null) child.kill();
        acquired = false;
        try {
          child.disconnect();
        } catch {}
        await child.exited;
        await error;
      }
    } finally {
      signal?.removeEventListener("abort", abort);
      done.resolve();
      void tail.then(() => {
        if (this.writers.get(physical.identity) === tail) this.writers.delete(physical.identity);
      });
    }
  }
}
