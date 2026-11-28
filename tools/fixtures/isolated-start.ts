import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { accepted, productRoot, startFirstSendFixture, type Fault } from "./first-send";
import { fixtureSigner } from "./first-send-client";
import { readManaged, openReceiptReader, hashId, confirmWriter } from "@kraka/environment";
import * as v from "valibot";
import { CommandReceiptSchema, REQUEST_METHODS } from "@kraka/protocol";
export function git(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(
    ["git", ...(process.platform === "win32" ? ["-c", "core.longpaths=true"] : []), ...args],
    {
      cwd,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
      timeout: 30000,
    },
  );
  if (r.exitCode !== 0) throw Error(r.stderr.toString());
  return r.stdout.toString().trimEnd();
}
export function seedGit(dir: string, name = "repo") {
  const version = git(dir, "--version");
  const parts = /^git version 2\.(\d+)\.(\d+)/.exec(version);
  if (!parts || Number(parts[1]) * 1000 + Number(parts[2]) < 50001)
    throw Error(`Git 2.50.1+ required: ${version}`);
  const path = join(realpathSync.native(dir), name);
  git(dir, "init", "-b", "main", path);
  const commit = (text: string) => {
    writeFileSync(join(path, "version.txt"), text);
    git(path, "add", "version.txt");
    git(path, "commit", "-m", text);
    return git(path, "rev-parse", "HEAD");
  };
  return { version, path, base: commit("first"), commit };
}
export async function isolatedFixture(dir: string, point: Fault = "peer", root = productRoot) {
  const repo = seedGit(dir),
    opts = {
      stateDir: join(dir, "state"),
      projectDirectory: repo.path,
      root,
      adapter: "replay" as const,
    };
  const f = await startFirstSendFixture({ ...opts, point });
  return {
    repo,
    opts,
    f,
    async restart() {
      const next = await startFirstSendFixture({ ...opts, point: "peer" });
      for (const line of next.stderrTail().split("\n"))
        if (line.startsWith("Writer startup timing ")) console.error(line);
      return next;
    },
  };
}
export type Fixture = Awaited<ReturnType<typeof startFirstSendFixture>>;
export function readClaim(state: string, id: string) {
  const db = openReceiptReader(state);
  try {
    const m = readManaged(db, id);
    if (!m) throw Error(`Missing worktree ${id}`);
    return m;
  } finally {
    db.close();
  }
}
export function setupPolicy(f: Fixture, setup: string[], prefix?: string) {
  const dir = join(f.instance.stateDirectory, "project-policies");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${hashId(f.project.id)}.json`),
    JSON.stringify({
      setup,
      rows: prefix
        ? [
            {
              target: {
                kind: "project",
                projectId: f.project.id,
                environmentId: f.project.environmentId,
              },
              field: "worktreeBranchNaming",
              explicit: { kind: "set", value: { kind: "fixedPrefix", prefix } },
              version: "1",
            },
          ]
        : [],
    }),
  );
}
export async function idle(f: Fixture) {
  const deadline = performance.now() + 30000;
  while (performance.now() < deadline) {
    if (await confirmWriter(f.instance.stateDirectory, deadline, true)) return;
    await Bun.sleep(15);
  }
  throw Error("Writer did not become idle");
}
export async function cli(
  f: Fixture,
  key: string,
  checkout:
    | { kind: "shared" }
    | { kind: "isolated"; selection: { branch: string; baseRef: string } | null },
) {
  const state = f.instance.stateDirectory;
  const child = Bun.spawn(
    [process.execPath, join(productRoot, "packages/cli-client/src/first-send.ts")],
    { cwd: productRoot, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  try {
    child.stdin.write(
      JSON.stringify({
        instance: f.instance,
        privateKeyPath: join(state, "fixture-private.pem"),
        signer: fixtureSigner,
        key,
        journal: join(state, "cli.sqlite"),
        input: { projectId: f.project.id, content: f.payload.content, checkout },
      }),
    );
    await child.stdin.end();
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (code !== 0) throw Error(stderr);
    const { receipt, request } = v.parse(
      v.object({ receipt: CommandReceiptSchema, request: REQUEST_METHODS.startThread.schema }),
      JSON.parse(stdout),
    );
    return { receipt, request, ids: accepted(receipt, "threadStarted") };
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
  }
}
export function peer(state: string, id: string) {
  return v.parse(
    v.object({ cwd: v.string(), attemptId: v.string(), deliveryId: v.string() }),
    JSON.parse(readFileSync(join(state, `peer-${id}`), "utf8")),
  );
}
