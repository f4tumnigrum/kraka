import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import * as v from "valibot";
import { ProcessIdentitySchema, type ProcessIdentity } from "@kraka/protocol";
import { worktreeWorkerCommand, writerStart } from "./worktree-worker";
import type { Managed } from "./worktree-storage";
import { exists } from "./worktree-git";
const exitRecord = v.strictObject({
  ...ProcessIdentitySchema.entries,
  token: v.string(),
  code: v.number(),
});
type Active = NonNullable<Managed["active"]>;
function paths(state: string, token: string) {
  const dir = join(state, "worktree-writers");
  return { dir, result: join(dir, `${token}.exit`) };
}
export function checkoutLease(state: string, directoryId: string) {
  const directory = join(state, "worktree-writers");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const db = new Database(join(directory, `${directoryId}.sqlite`), { create: true });
  try {
    db.run("PRAGMA busy_timeout=5000");
    db.run("BEGIN EXCLUSIVE");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
export function outcome(state: string, active: Active) {
  const path = paths(state, active.token).result;
  if (!exists(path)) return null;
  const record = v.parse(exitRecord, JSON.parse(readFileSync(path, "utf8")));
  if (
    record.token !== active.token ||
    record.pid !== active.process.pid ||
    record.startedAt !== active.process.startedAt
  )
    throw Error("Foreign writer evidence");
  return record.code;
}
export function forgetOutcome(state: string, token: string) {
  rmSync(paths(state, token).result, { force: true });
}
export async function waitForOriginal(state: string, active: Active) {
  const deadline = performance.now() + (active.kind === "git" ? 300000 : 900000) + 4000;
  while (outcome(state, active) === null) {
    const started = await writerStart(active.process.pid).catch(() => null);
    if (started !== active.process.startedAt || performance.now() >= deadline)
      return outcome(state, active);
    await Bun.sleep(50);
  }
  return outcome(state, active);
}
export async function runWriter(
  state: string,
  directoryId: string,
  kind: Active["kind"],
  cwd: string,
  argv: string[],
  input: Buffer,
  register: (active: Active) => void,
) {
  const token = crypto.randomUUID(),
    { dir, result } = paths(state, token);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const task = {
    token,
    lease: join(dir, `${directoryId}.sqlite`),
    result,
    cwd,
    argv,
    seconds: kind === "git" ? 300 : 900,
  };
  const entry = Bun.isStandaloneExecutable ? [] : [Bun.main];
  const child = Bun.spawn(
    [process.execPath, ...entry, worktreeWorkerCommand, JSON.stringify(task)],
    {
      detached: process.platform !== "win32",
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  try {
    const stream = child.stdout.getReader(),
      decoder = new TextDecoder();
    let header = "";
    while (!header.includes("\n")) {
      const chunk = await stream.read();
      if (chunk.done) throw Error(`Writer lease unavailable: ${await errors}`);
      header += decoder.decode(chunk.value, { stream: true });
    }
    const identity: ProcessIdentity = v.parse(ProcessIdentitySchema, JSON.parse(header));
    if (identity.pid !== child.pid) throw Error("Wrong writer");
    const active = { token, kind, process: identity };
    register(active);
    child.stdin.write(JSON.stringify({ token, input: input.toString("base64") }));
    await child.stdin.end();
    const status = await child.exited;
    if (status !== 0) throw Error(`Unconfirmed writer exit: ${await errors}`);
    const code = outcome(state, active);
    if (code === null) throw Error("Missing writer exit");
    return { code, active };
  } finally {
    child.stdin.end();
    await child.exited;
    await errors;
  }
}
