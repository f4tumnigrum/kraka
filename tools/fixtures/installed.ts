import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { existsSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as v from "valibot";
import { InstancePublicationSchema, readInstancePublication } from "@kraka/environment";
import { openAccessHost } from "../../packages/daemon/src/access";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import {
  DeviceIdSchema,
  DeviceKeyIdSchema,
  P256PublicKeySchema,
  EnvironmentIdentitySchema,
  DevicePrincipalSchema,
} from "@kraka/protocol";
import { terminate, within } from "./replay-process";
import { buildArtifact, hostTarget, installArtifact, readArtifact } from "../package-release";
import manifest from "../../packages/daemon/package.json";

export async function releaseForRoot(root: string, outputDirectory: string) {
  const child = Bun.spawn(
    [process.execPath, join(root, "tools/package-release.ts"), "--host", "--out", outputDirectory],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw Error("Build failed: " + err);
  return readArtifact(v.parse(v.object({ archive: v.string() }), JSON.parse(out)).archive);
}
export async function hostRelease(out: string) {
  return process.env.KRAKA_TEST_ARCHIVE
    ? readArtifact(resolve(process.env.KRAKA_TEST_ARCHIVE))
    : buildArtifact({ ...hostTarget(), version: manifest.version, outputDirectory: out });
}
export async function installedDirectory(dir: string, bin: string) {
  const cwd = join(dir, "workspace"),
    client = join(dir, "client"),
    state = join(dir, "state");
  await mkdir(cwd, { recursive: true });
  const git = Bun.which("git");
  if (!git) throw Error("Git is required");
  const system = process.env.SystemRoot ?? "C:\\Windows";
  const paths = [dirname(bin)];
  if (process.platform === "win32")
    paths.push(
      dirname(git),
      join(system, "System32"),
      join(system, "System32", "WindowsPowerShell", "v1.0"),
    );
  else {
    const tools = await mkdtemp(join(dir, "path-"));
    await symlink(git, join(tools, "git"));
    paths.push(tools);
  }
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["PATH", "NODE_PATH"].includes(key.toUpperCase()),
    ),
  );
  const env = { ...inherited, PATH: paths.join(delimiter), KRAKA_CLIENT_DIR: client };
  if (Bun.which("bun", { PATH: env.PATH, cwd })) throw Error("Bun visible in product PATH");
  const selected = Bun.which(basename(bin), { PATH: env.PATH, cwd });
  if (!selected || (await realpath(selected)) !== (await realpath(bin)))
    throw Error("Installed program missing from product PATH");
  return { bin: selected, cwd, state, client, env };
}
type Installation = Awaited<ReturnType<typeof installedDirectory>>;
export async function runIdentity(site: Installation) {
  const child = Bun.spawn([site.bin, "identity", "--state-dir", site.state, "--json"], {
    cwd: site.cwd,
    env: site.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw Error("Installed identity failed: " + err);
  return v.parse(
    v.strictObject({ environmentId: EnvironmentIdentitySchema.entries.id }),
    JSON.parse(out),
  ).environmentId;
}
export function startInstalled(site: Installation, mode?: string) {
  const start = performance.now();
  const child = Bun.spawn([site.bin, "start", "--state-dir", site.state, ...(mode ? [mode] : [])], {
    cwd: site.cwd,
    env: site.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  const lines = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity });
  const reader = lines[Symbol.asyncIterator]();
  let records = 0;
  async function next<S extends v.GenericSchema>(schema: S): Promise<v.InferOutput<S>> {
    const result = await within(reader.next(), 15000, "Installed daemon output").catch((error) => {
      const flags = [
        "writer.lock.sqlite",
        "environment.sqlite",
        "access.sqlite",
        "instance.json",
      ].filter((name) => existsSync(join(site.state, name)));
      const client = existsSync(join(site.client, "device.sqlite"));
      let children = "";
      if (process.platform === "win32") {
        const result = Bun.spawnSync(
          [
            "powershell.exe",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter 'ParentProcessId=${child.pid}').Name`,
          ],
          { timeout: 8000, stdout: "pipe", stderr: "ignore" },
        );
        children = result.stdout.toString().trim();
      }
      throw Error(
        `${error}; record ${records + 1}, state directory ${existsSync(site.state)}, state files [${flags}], device store ${client}, children [${children}]`,
      );
    });
    if (result.done) {
      const code = await child.exited;
      throw Error(
        `Daemon exited before record (exit ${code}, signal ${child.signalCode ?? "none"}, state directory ${existsSync(site.state) ? "present" : "absent"}): ${await errors}`,
      );
    }
    records++;
    return v.parse(schema, JSON.parse(result.value));
  }
  async function ready() {
    const { publication } = await next(
      v.strictObject({ kind: v.literal("ready"), publication: InstancePublicationSchema }),
    );
    if (
      publication.pid !== child.pid ||
      !Bun.deepEquals(await readInstancePublication(site.state), publication)
    )
      throw Error("Unconfirmed installed instance");
    return publication;
  }
  async function input(line: string) {
    child.stdin.write(line + "\n");
    await child.stdin.flush();
  }
  async function register(request?: v.InferOutput<typeof ownerPrompt>) {
    const prompt = request ?? (await next(ownerPrompt));
    const local = await openDeviceCredentials(join(site.client, "device.sqlite"));
    try {
      if (
        prompt.deviceId !== local.deviceId ||
        prompt.keyId !== local.keyId ||
        prompt.publicKey !== local.publicKey
      )
        throw Error("Confirmation does not identify this disposable CLI");
      const host = await openAccessHost(site.state, {
        present: async () => true,
        approve: async (detail) =>
          detail.operation === "bootstrap" &&
          detail.environment.id === prompt.identity.id &&
          detail.deviceId === prompt.deviceId &&
          detail.keyId === prompt.keyId &&
          detail.publicKey === prompt.publicKey,
      });
      try {
        if (
          (await host.trusted.confirm({
            kind: "bootstrap",
            environment: prompt.identity,
            deviceId: local.deviceId,
            keyId: local.keyId,
            publicKey: local.publicKey,
          })) !== "registered"
        )
          throw Error("Disposable owner bootstrap failed");
      } finally {
        host.close();
      }
    } finally {
      local.close();
    }
    await input("register " + prompt.confirmationCode);
    const owner = await next(
      v.object({ kind: v.literal("owner.registered"), principal: DevicePrincipalSchema }),
    );
    return { identity: prompt.identity, principal: owner.principal };
  }
  return {
    child,
    next,
    ready,
    register,
    start,
    input,
    async close() {
      await terminate(child);
      lines.close();
      await errors;
    },
  };
}
export const ownerPrompt = v.object({
  kind: v.literal("owner.confirm"),
  identity: EnvironmentIdentitySchema,
  deviceId: DeviceIdSchema,
  keyId: DeviceKeyIdSchema,
  publicKey: P256PublicKeySchema,
  confirmationCode: v.pipe(v.string(), v.regex(/^\d{6}$/)),
});
export const pairingRecord = v.strictObject({
  kind: v.literal("pairing"),
  environmentId: EnvironmentIdentitySchema.entries.id,
  inviteId: v.string(),
  url: v.string(),
  expiresAt: v.number(),
});
export async function disposableRelease<T>(
  artifact: Awaited<ReturnType<typeof hostRelease>>,
  run: (site: Installation, dir: string) => Promise<T>,
) {
  const dir = await mkdtemp(join(tmpdir(), "kraka-installed-"));
  try {
    return await run(
      await installedDirectory(dir, await installArtifact(artifact, join(dir, "prefix"))),
      dir,
    );
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}
