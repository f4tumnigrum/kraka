import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { releaseExecutable } from "./release-archive";
import { tmpdir } from "node:os";
import { parseInstalledCommand } from "../packages/daemon/src";
import {
  DeviceRouteDirectory,
  openDeviceCredentials,
  verifiedIdentity,
} from "../packages/cli-client/src";
import { openAccessHost } from "../packages/daemon/src/access";
import { hostRelease } from "./fixtures/installed";
import { buildArtifact, hostTarget, inspectArchive, installArtifact } from "./package-release";
import { DEFAULT_DEVICE_PERMISSIONS, ProjectIdSchema } from "@kraka/protocol";
import * as v from "valibot";
let dir: string, artifact: Awaited<ReturnType<typeof hostRelease>>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kraka-package-"));
  artifact = await hostRelease(dir);
}, 120000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
test("a platform archive contains one executable", async () => {
  expect(artifact.target).toEqual(hostTarget());
  expect(await inspectArchive(artifact)).toEqual({
    archiveBytes: artifact.archiveBytes,
    executableBytes: artifact.executableBytes,
  });
  const prefix = join(dir, "install without tar");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "package-release.ts"),
      "--install",
      artifact.archive,
      "--prefix",
      prefix,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "PATH"),
        ),
        PATH: dir,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [exit, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exit !== 0) throw Error("In-process installation failed: " + err);
  const bin = out.trim();
  const st = await stat(bin);
  expect(st.size).toBe(artifact.executableBytes);
  if (process.platform !== "win32") expect(st.mode & 0o111).toBe(0o111);
}, 30000);
test("a release with another regular file is rejected", async () => {
  const archive = await new Bun.Archive(
    { kraka: "program", README: "notes" },
    { compress: "gzip" },
  ).bytes();
  expect(() => releaseExecutable(Buffer.from(archive), "kraka", 7)).toThrow(
    "Expected one regular executable",
  );
});
test("an interrupted install leaves the previous complete version selected", async () => {
  const prefix = join(dir, "interrupt"),
    previous = await installArtifact(artifact, prefix);
  const next = await buildArtifact({ ...hostTarget(), version: "0.1.1", outputDirectory: dir });
  const staged = Promise.withResolvers<void>();
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures/interrupted-install.ts"),
      next.archive,
      prefix,
    ],
    {
      ipc(message) {
        if (message === "verified") staged.resolve();
      },
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  const errors = new Response(child.stderr).text();
  try {
    await Promise.race([
      staged.promise,
      child.exited.then(async (code) => {
        throw Error("Stage failed " + code + " " + (await errors));
      }),
    ]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await child.exited;
    await errors;
  }
  const pointer = join(prefix, process.platform === "win32" ? "active.json" : "bin/active.json");
  expect(await Bun.file(pointer).json()).toEqual({ version: artifact.version });
  expect(Bun.SHA256.hash(await readFile(previous), "hex")).toBe(artifact.executableSha256);
  const active = await installArtifact(next, prefix);
  expect(Bun.SHA256.hash(await readFile(active), "hex")).toBe(next.executableSha256);
}, 30000);
test("two startup modes cannot both claim the browser action", () => {
  expect(() =>
    parseInstalledCommand("start", ["--state-dir", dir, "--print-pairing", "--open-browser"]),
  ).toThrow("one startup mode");
  expect(parseInstalledCommand("start", ["--state-dir", dir])).toEqual({
    kind: "foreground",
    action: "print",
    stateDir: dir,
  });
});
test("a development service on the same host receives zero device signatures", async () => {
  const local = await openDeviceCredentials(join(dir, "client", "device.sqlite"));
  const host = await openAccessHost(join(dir, "host"), {
    present: async () => true,
    approve: async () => true,
  });
  const catalog = new DeviceRouteDirectory(join(dir, "client", "routes.sqlite"));
  let signatures = 0,
    frames = 0;
  const service = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req)) return;
      return new Response("development service");
    },
    websocket: {
      open(ws) {
        ws.send(JSON.stringify({ kind: "development", port: 1234 }));
      },
      message() {
        frames++;
      },
    },
  });
  try {
    await host.trusted.confirm({
      kind: "bootstrap",
      environment: host.identity,
      deviceId: local.deviceId,
      keyId: local.keyId,
      publicKey: local.publicKey,
    });
    const owner = host.store.device(local.deviceId);
    if (!owner) throw Error("Missing local fixture owner");
    local.saveHostRegistration({
      kind: "registered",
      identity: host.identity,
      deviceId: local.deviceId,
      keyId: local.keyId,
      publicKey: local.publicKey,
      ...owner,
      target: { kind: "project", projectId: v.parse(ProjectIdSchema, "local") },
      permissions: [...DEFAULT_DEVICE_PERMISSIONS],
    });
    await expect(
      verifiedIdentity(
        {
          ...local,
          sign(message) {
            signatures++;
            return local.sign(message);
          },
        },
        catalog,
        host.identity.id,
        `ws://127.0.0.1:${service.port}/ws`,
        AbortSignal.timeout(4000),
      ),
    ).rejects.toThrow("unavailable");
    expect([signatures, frames]).toEqual([0, 0]);
  } finally {
    catalog.close();
    local.close();
    host.close();
    await service.stop(true);
  }
});
