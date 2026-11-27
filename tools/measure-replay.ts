import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { entry, launch, sampleRequest, withState } from "./fixtures/replay-process";
import { driveReplay } from "./replay-client";

function command(argv: string[], cwd?: string) {
  const result = Bun.spawnSync(argv, {
    cwd: cwd ?? process.cwd(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  if (result.exitCode !== 0)
    throw new Error(`${argv[0]} exited ${result.exitCode}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
async function digest(root: string) {
  const hash = createHash("sha256");
  async function visit(dir: string) {
    for (const name of (await readdir(join(root, dir))).sort()) {
      if ([".git", "node_modules", ".build"].includes(name)) continue;
      const path = dir ? `${dir}/${name}` : name;
      const full = join(root, path);
      const stat = await lstat(full);
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile())
        hash
          .update(path)
          .update("\0")
          .update(await readFile(full))
          .update("\0");
    }
  }
  await visit("");
  return `source-sha256:${hash.digest("hex")}`;
}
async function identity(root: string, baseline: boolean) {
  const git = await lstat(join(root, ".git")).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (git?.isDirectory() || git?.isFile()) {
    const revision = command(["git", "rev-parse", "HEAD"], root).trim();
    if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Invalid Git HEAD");
    return {
      revision,
      ...(command(["git", "status", "--porcelain"], root).trim()
        ? { digest: await digest(root) }
        : {}),
    };
  }
  if (
    baseline &&
    process.env.BASE_SHA &&
    process.env.GITHUB_EVENT_NAME === "pull_request" &&
    process.env.GITHUB_ACTIONS === "true"
  ) {
    if (!/^[0-9a-f]{40}$/.test(process.env.BASE_SHA)) throw new Error("Invalid archived BASE_SHA");
    return { revision: process.env.BASE_SHA };
  }
  return { revision: await digest(root) };
}
function median(values: number[], unit: string, limit: number) {
  if (values.length !== 10) throw new Error(`Expected ten ${unit} samples`);
  const sorted = [...values].sort((a, b) => a - b);
  const value = ((sorted[4] ?? NaN) + (sorted[5] ?? NaN)) / 2;
  console.log(JSON.stringify({ unit, median: value, samples: values.length, limit }));
  if (!Number.isFinite(value) || value > limit) throw new Error(`${unit} median exceeds budget`);
}
function noChildren(pid: number) {
  const res = Bun.spawnSync(["pgrep", "-P", String(pid)], {
    stdout: "pipe",
    stderr: "pipe",
    timeout: 5000,
  });
  if (res.exitCode !== 1 || res.signalCode != null || res.stdout.length || res.stderr.length)
    throw new Error(
      `Cannot confirm zero children for ${pid}: ${res.exitCode} ${res.stdout} ${res.stderr}`,
    );
}
function currentFootprint(pid: number) {
  try {
    const raw = command(["footprint", "--noCategories", "-f", "bytes", "-p", String(pid)]);
    const ids = [...raw.matchAll(/^.*?\[(\d+)\]:.*?Footprint:/gm)];
    const values = [...raw.matchAll(/^\s*phys_footprint:\s*([\d,]+)\s*B\s*$/gm)];
    const bytes = Number(values[0]?.[1]?.replaceAll(",", ""));
    if (
      ids.length !== 1 ||
      ids[0]?.[1] !== String(pid) ||
      values.length !== 1 ||
      !Number.isSafeInteger(bytes) ||
      bytes <= 0
    )
      throw new Error(`Invalid footprint output: ${raw}`);
    return { source: "footprint phys_footprint", raw: bytes, unit: "bytes", mib: bytes / 1048576 };
  } catch (error) {
    console.error(String(error));
  }
  const raw = command(["vmmap", "--summary", String(pid)]);
  const ids = [...raw.matchAll(/^Process:.*\[(\d+)\]\s*$/gm)];
  const values = [...raw.matchAll(/^Physical footprint:\s*([\d.]+)\s*(B|K|M|G)(?:i?B)?\s*$/gm)];
  const value = Number(values[0]?.[1]);
  const unit = values[0]?.[2];
  const multiplier = unit === "B" ? 1 / 1048576 : unit === "K" ? 1 / 1024 : unit === "M" ? 1 : 1024;
  if (
    ids.length !== 1 ||
    ids[0]?.[1] !== String(pid) ||
    values.length !== 1 ||
    !Number.isFinite(value) ||
    value <= 0
  )
    throw new Error(`Invalid vmmap reading: ${raw}`);
  return { source: "vmmap current Physical footprint", raw: value, unit, mib: value * multiplier };
}
async function measure(root: string, baseline: boolean) {
  const revision = await identity(root, baseline);
  const role = baseline ? "baseline" : "candidate";
  console.log(
    JSON.stringify({
      role,
      ...revision,
      os: platform(),
      release: release(),
      architecture: arch(),
      cpu: cpus()[0]?.model,
      memoryBytes: totalmem(),
      bun: Bun.version,
      method:
        "monotonic spawn to validated receipt; drain eight updates and close 1000; macOS current physical footprint at acceptance + 60000 ms",
    }),
  );
  const samples: { empty: number[]; reused: number[]; idle: number[] } = {
    empty: [],
    reused: [],
    idle: [],
  };
  let launches = 0,
    accepted = 0,
    ended = 0,
    normalCloses = 0;
  async function sample(dir: string, kind: keyof typeof samples) {
    const daemon = launch(root, dir);
    launches++;
    try {
      const ready = await daemon.ready();
      if (ready.kind === "exit") {
        const source = (await readFile(join(root, entry), "utf8")).replace(/\s/g, "");
        if (
          baseline &&
          launches === 1 &&
          accepted === 0 &&
          source === 'import"@kraka/cli-client";import"@kraka/environment";' &&
          ready.code === 0 &&
          ready.signal === null &&
          ready.stdout === "" &&
          ready.stderr === ""
        ) {
          console.log(
            "baseline=unavailable exit=0 ready=none accepted=0 launches=1 revision=" +
              revision.revision,
          );
          return false;
        }
        throw new Error(`Unexpected daemon exit ${JSON.stringify(ready)}`);
      }
      let at = 0;
      await driveReplay(ready.url, sampleRequest, (message) => {
        if (message.kind === "accepted") {
          at = performance.now();
          accepted++;
        }
        if (message.kind === "round.ended") ended++;
      });
      normalCloses++;
      if (!at || accepted !== launches || ended !== launches || normalCloses !== launches)
        throw new Error("Incomplete measured work");
      const { child } = daemon,
        pid = child.pid;
      function alive() {
        if (child.pid !== pid || child.exitCode !== null || child.signalCode !== null)
          throw new Error("Daemon exited before sampling");
        process.kill(pid, 0);
      }
      alive();
      if (process.platform === "darwin") {
        const listener = command([
          "lsof",
          "-nP",
          "-a",
          "-p",
          String(pid),
          "-iTCP",
          "-sTCP:LISTEN",
          "-Fn",
        ]);
        if (!listener.split("\n").includes(`n127.0.0.1:${new URL(ready.url).port}`))
          throw new Error(`Ready listener PID mismatch: ${listener}`);
      }
      if (kind === "idle") {
        await Bun.sleep(Math.max(0, Math.ceil(at + 60000 - performance.now())));
        alive();
        noChildren(pid);
        const elapsedMs = performance.now() - at;
        const memory = currentFootprint(pid);
        noChildren(pid);
        alive();
        console.log(
          JSON.stringify({
            role,
            kind,
            launches,
            pid,
            elapsedMs,
            ...memory,
            accepted,
            ended,
            normalCloses,
          }),
        );
        samples.idle.push(memory.mib);
      } else {
        const elapsedMs = at - daemon.started;
        console.log(
          JSON.stringify({ role, kind, launches, pid, elapsedMs, accepted, ended, normalCloses }),
        );
        samples[kind].push(elapsedMs);
      }
      return true;
    } finally {
      await daemon.stop();
    }
  }
  try {
    for (let pair = 0; pair < 10; pair++) {
      const available = await withState(
        async (dir) => (await sample(dir, "empty")) && (await sample(dir, "reused")),
      );
      if (!available) return;
    }
    median(samples.empty, "empty ms", 500);
    median(samples.reused, "reused ms", 300);
    if (process.platform === "darwin") {
      for (let i = 0; i < 10; i++) await withState((dir) => sample(dir, "idle"));
      median(samples.idle, "idle MiB", 150);
    } else console.log("P2=macOS-only");
  } finally {
    console.log(JSON.stringify({ role, launches, accepted, ended, normalCloses }));
  }
}
if (import.meta.main) {
  try {
    const [flag, path, ...extra] = process.argv.slice(2);
    if (
      !path ||
      path.startsWith("--") ||
      extra.length ||
      (flag !== "--baseline-root" && flag !== "--root")
    )
      throw new Error("Expected --baseline-root DIR or --root DIR");
    await measure(resolve(path), flag === "--baseline-root");
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
