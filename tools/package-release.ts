import { productionClosure, type DependencyObservation } from "./perf-dependencies";
import { releaseExecutable } from "./release-archive";
import { Database } from "bun:sqlite";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { ActiveReleasePointerSchema, releaseDirectory } from "@kraka/environment";
import { ReleaseVersionSchema } from "@kraka/protocol";
import { compileDaemon } from "../packages/daemon/build";
import manifest from "../packages/daemon/package.json";

const platform = {
  os: v.picklist(["darwin", "linux", "win32"]),
  arch: v.picklist(["x64", "arm64"]),
  libc: v.nullable(v.picklist(["glibc", "musl"])),
};
const targetSchema = v.pipe(
  v.strictObject(platform),
  v.check((t) => (t.os === "linux") === (t.libc !== null)),
);
export type ReleaseTarget = v.InferOutput<typeof targetSchema>;
const bytes = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const digest = v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/));
const reportSchema = v.strictObject({
  target: targetSchema,
  version: ReleaseVersionSchema,
  archive: v.string(),
  archiveBytes: bytes,
  sha256: digest,
  executableName: v.picklist(["kraka", "kraka.exe"]),
  executableBytes: bytes,
  executableSha256: digest,
});
export type Artifact = v.InferOutput<typeof reportSchema>;
export function hostTarget(): ReleaseTarget {
  const header =
    process.platform === "linux"
      ? v.parse(
          v.object({ header: v.object({ glibcVersionRuntime: v.optional(v.string()) }) }),
          process.report.getReport(),
        ).header
      : null;
  return v.parse(targetSchema, {
    os: process.platform,
    arch: process.arch,
    libc: header ? (header.glibcVersionRuntime ? "glibc" : "musl") : null,
  });
}
export function targetLabel(t: ReleaseTarget) {
  return [t.os, t.arch, t.libc].filter(Boolean).join("-");
}
async function sha256(path: string) {
  const hash = createHash("sha256");
  for await (const buf of createReadStream(path)) hash.update(buf);
  return hash.digest("hex");
}
async function packExecutable(directory: string, archiveName: string, executableName: string) {
  const child = Bun.spawn(["tar", "--format=ustar", "-czf", archiveName, executableName], {
    cwd: directory,
    env: { ...process.env, COPYFILE_DISABLE: "1" },
    stdout: "ignore",
    stderr: "pipe",
  });
  const [code, err] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw Error("Archive creation failed: " + err.trim());
}
export async function buildArtifact({
  version,
  outputDirectory,
  ...input
}: ReleaseTarget & { version: string; outputDirectory: string }): Promise<Artifact> {
  const target = v.parse(targetSchema, input);
  v.parse(ReleaseVersionSchema, version);
  if (Bun.version !== "1.4.5") throw Error("Release builds require Bun 1.4.5");
  const out = resolve(outputDirectory);
  await mkdir(out, { recursive: true });
  const stage = await mkdtemp(join(out, ".build-"));
  try {
    const executableName = target.os === "win32" ? "kraka.exe" : "kraka";
    const file = join(stage, executableName);
    const compileTarget: Bun.Build.CompileTarget =
      target.os === "linux"
        ? target.libc === "musl"
          ? `bun-linux-${target.arch}-musl`
          : `bun-linux-${target.arch}`
        : target.os === "win32"
          ? `bun-windows-${target.arch}`
          : `bun-darwin-${target.arch}`;
    await compileDaemon(file, version, compileTarget);
    const name = `kraka-${version}-${targetLabel(target)}.tar.gz`;
    const archive = join(out, name),
      temp = join(stage, name);
    await chmod(file, 0o755);
    await packExecutable(stage, name, executableName);
    const result = v.parse(reportSchema, {
      target,
      version,
      archive,
      archiveBytes: (await stat(temp)).size,
      sha256: await sha256(temp),
      executableName,
      executableBytes: (await stat(file)).size,
      executableSha256: await sha256(file),
    });
    await writeFile(temp + ".json", JSON.stringify({ ...result, archive: name }) + "\n");
    await rename(temp, archive);
    await rename(temp + ".json", archive + ".json");
    return result;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
export async function readArtifact(archive: string) {
  const report = v.parse(reportSchema, JSON.parse(await readFile(archive + ".json", "utf8")));
  if (
    basename(report.archive) !== basename(archive) ||
    report.executableName !== (report.target.os === "win32" ? "kraka.exe" : "kraka")
  )
    throw Error("Release target or name mismatch");
  return { ...report, archive: resolve(archive) };
}
async function verifiedExecutable(artifact: Artifact) {
  if (artifact.executableName !== (artifact.target.os === "win32" ? "kraka.exe" : "kraka"))
    throw Error("Release target or name mismatch");
  const compressed = await readFile(artifact.archive);
  if (
    compressed.length !== artifact.archiveBytes ||
    Bun.SHA256.hash(compressed, "hex") !== artifact.sha256
  )
    throw Error("Archive digest mismatch");
  const executable = releaseExecutable(
    compressed,
    artifact.executableName,
    artifact.executableBytes,
  );
  if (Bun.SHA256.hash(executable, "hex") !== artifact.executableSha256)
    throw Error("Extracted executable digest mismatch");
  return executable;
}
export async function inspectArchive(report: Artifact) {
  const artifact = v.parse(reportSchema, report);
  const executable = await verifiedExecutable(artifact);
  return { archiveBytes: artifact.archiveBytes, executableBytes: executable.length };
}
export async function installArtifact(
  report: Artifact,
  prefix: string,
  beforeActivate?: () => Promise<void>,
) {
  const artifact = v.parse(reportSchema, report);
  if (!Bun.deepEquals(artifact.target, hostTarget()))
    throw Error("Release target does not match host");
  const executable = await verifiedExecutable(artifact);
  const entry = artifact.executableName;
  const versionDir = join(
    prefix,
    releaseDirectory(v.parse(ActiveReleasePointerSchema, { version: artifact.version })),
  );
  await mkdir(dirname(versionDir), { recursive: true });
  const stage = await mkdtemp(join(dirname(versionDir), ".install-"));
  const windows = process.platform === "win32";
  const active = join(prefix, windows ? "active.json" : "bin");
  const pointer = active + "." + crypto.randomUUID();
  const selected = JSON.stringify({ version: artifact.version }) + "\n";
  try {
    await writeFile(join(stage, entry), executable, { flag: "wx", mode: 0o755 });
    const verify = async (file: string) => {
      const s = await lstat(file);
      if (
        !s.isFile() ||
        s.size !== artifact.executableBytes ||
        (await sha256(file)) !== artifact.executableSha256
      )
        throw Error("Installed executable digest mismatch");
    };
    await verify(join(stage, entry));
    await chmod(join(stage, entry), 0o755);
    await writeFile(join(stage, "active.json"), selected, { flag: "wx" });
    const db = new Database(join(prefix, "install.lock.sqlite"), { create: true });
    try {
      db.run("PRAGMA busy_timeout=0");
      const deadline = performance.now() + 10_000;
      for (;;) {
        try {
          db.run("BEGIN EXCLUSIVE");
          break;
        } catch (error) {
          if (
            !(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") ||
            performance.now() >= deadline
          )
            throw error;
          await Bun.sleep(25);
        }
      }
      if (await Bun.file(join(versionDir, entry)).exists()) {
        await verify(join(versionDir, entry));
        const installed = v.parse(
          ActiveReleasePointerSchema,
          await Bun.file(join(versionDir, "active.json")).json(),
        );
        if (installed.version !== artifact.version) throw Error("Installed version mismatch");
      } else await rename(stage, versionDir);
      await beforeActivate?.();
      if (windows) await writeFile(pointer, selected, { flag: "wx" });
      else await symlink(relative(prefix, versionDir), pointer, "dir");
      await rename(pointer, active);
      const current = v.parse(
        ActiveReleasePointerSchema,
        await Bun.file(windows ? active : join(active, "active.json")).json(),
      );
      return join(windows ? join(prefix, releaseDirectory(current)) : active, entry);
    } finally {
      db.close(true);
    }
  } finally {
    await rm(pointer, { force: true });
    await rm(stage, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      host: { type: "boolean" },
      out: { type: "string" },
      os: { type: "string" },
      arch: { type: "string" },
      libc: { type: "string" },
      install: { type: "string" },
      prefix: { type: "string" },
    },
    allowPositionals: false,
  });
  if (values.install && values.prefix)
    console.log(await installArtifact(await readArtifact(values.install), resolve(values.prefix)));
  else {
    if (!values.out || (values.host && (values.os || values.arch || values.libc)))
      throw Error("Expected --host or --os OS --arch CPU [--libc ABI], and --out DIR");
    const target = values.host
      ? hostTarget()
      : v.parse(targetSchema, { os: values.os, arch: values.arch, libc: values.libc ?? null });
    const artifact = await buildArtifact({
      ...target,
      version: manifest.version,
      outputDirectory: values.out,
    });
    const sizes = await inspectArchive(artifact);
    const closure: DependencyObservation = { packages: [], workspaces: [] };
    await productionClosure(resolve(import.meta.dir, ".."), closure, target);
    const native = closure.packages.filter((p) => p.native).length;
    await writeFile(
      artifact.archive + ".budgets.json",
      JSON.stringify({
        target,
        sha256: artifact.sha256,
        P8: { ...sizes, limitBytes: 120_000_000 },
        A1: { ...closure, native, external: closure.packages.length },
      }) + "\n",
    );
    if (sizes.archiveBytes > 120_000_000 || closure.packages.length > 15 || native)
      throw Error("Release exceeds P8/A1 budgets");
    console.log(JSON.stringify(artifact));
  }
}
