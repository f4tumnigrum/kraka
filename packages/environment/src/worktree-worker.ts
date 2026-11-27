import { Database } from "bun:sqlite";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "node:fs";
import * as v from "valibot";

export const worktreeWorkerCommand = "--internal-worktree-writer";
const taskSchema = v.strictObject({
  token: v.pipe(v.string(), v.uuid()),
  lease: v.string(),
  result: v.string(),
  cwd: v.string(),
  argv: v.tupleWithRest([v.string()], v.string()),
  seconds: v.picklist([300, 900]),
});

function ps(...args: string[]) {
  const result = Bun.spawnSync(["/bin/ps", ...args], {
    detached: true,
    timeout: 2000,
    env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
  });
  if (result.exitCode !== 0) throw Error("Cannot observe process");
  return result.stdout.toString().trim();
}
export async function writerStart(pid: number) {
  if (process.platform === "win32")
    return (await import("./worktree-windows")).windowsProcessStart(pid);
  const time = Date.parse(`${ps("-o", "lstart=", "-p", String(pid))} GMT`);
  if (!Number.isSafeInteger(time)) throw Error("Invalid process start time");
  return time;
}
function ownPosixGroup() {
  const pid = process.pid;
  if (Number(ps("-o", "pgid=", "-p", String(pid))) !== pid)
    throw Error("Writer needs a private process group");
  process.on("SIGTERM", () => {}); // Stay alive to verify all members have stopped.
  return {
    alone() {
      const members = ps("-A", "-o", "pid=", "-o", "pgid=")
        .split("\n")
        .map((row) => {
          const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(row);
          if (!match) throw Error("Unknown process group membership");
          return { pid: Number(match[1]), group: Number(match[2]) };
        })
        .filter((member) => member.group === pid);
      if (!members.some((member) => member.pid === pid))
        throw Error("Writer group leader unconfirmed");
      return members.length === 1;
    },
    force() {
      process.kill(-pid, "SIGKILL");
    },
  };
}
async function exitedWithin(exit: Promise<number>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      exit,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export async function runWorktreeWorker(arg: string | undefined) {
  const task = v.parse(taskSchema, JSON.parse(arg ?? "null"));
  const group =
    process.platform === "win32"
      ? (await import("./worktree-windows")).ownWindowsJob()
      : ownPosixGroup();
  const identity = { pid: process.pid, startedAt: await writerStart(process.pid) };
  const db = new Database(task.lease);
  try {
    db.run("BEGIN EXCLUSIVE");
    // A read can remain pending on an open pipe. Exit releases the OS lease.
    const permissionTimeout = setTimeout(() => process.exit(1), 5000);
    let input: Buffer;
    try {
      process.stdout.write(`${JSON.stringify(identity)}\n`);
      const permit = v.parse(
        v.strictObject({ token: v.literal(task.token), input: v.string() }),
        await Bun.stdin.json(),
      );
      input = Buffer.from(permit.input, "base64");
    } finally {
      clearTimeout(permissionTimeout);
    }
    const child = Bun.spawn(task.argv, {
      cwd: task.cwd,
      stdin: input.length ? input : "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    const code = await exitedWithin(child.exited, task.seconds * 1000);
    const interrupted = code === null || !group.alone();
    if (interrupted) {
      if (process.platform === "win32") {
        if (code === null) child.kill("SIGTERM");
      } else process.kill(-process.pid, "SIGTERM");
      const deadline = performance.now() + 2000;
      while (!group.alone() && performance.now() < deadline) await Bun.sleep(25);
      if (!group.alone()) {
        // The group includes this helper. Forced death cannot publish exit proof.
        group.force();
        throw Error("Unconfirmed group exit");
      }
      await child.exited;
    }
    const fd = openSync(`${task.result}.tmp`, "wx", 0o600);
    try {
      writeFileSync(
        fd,
        JSON.stringify({ ...identity, token: task.token, code: interrupted ? 1 : code }),
      );
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(`${task.result}.tmp`, task.result);
  } finally {
    db.close();
  }
}
