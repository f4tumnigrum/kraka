import { beforeAll, afterAll, expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as v from "valibot";
import { InstancePublicationSchema } from "@kraka/environment";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  EnvironmentIdentitySchema,
  PairingCompletedSchema,
  PairingPendingSchema,
  ExecutorInstanceIdSchema,
  PairingInviteIdSchema,
  ProjectIdSchema,
} from "@kraka/protocol";
import { openDeviceCredentials } from "../packages/cli-client/src";
import { beginApplication, commandId, connectDevice } from "./fixtures/paired-project";
import {
  hostRelease,
  disposableRelease,
  pairingRecord,
  ownerPrompt,
  runIdentity,
  startInstalled,
} from "./fixtures/installed";
import { installArtifact } from "./package-release";
import { buildPeer } from "./fixtures/codex-turn";
import { accepted } from "./fixtures/first-send";
let dir: string, opener: string, peer: string, artifact: Awaited<ReturnType<typeof hostRelease>>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kraka-release-test-"));
  artifact = await hostRelease(dir);
  opener = join(dir, process.platform === "win32" ? "record-opener.exe" : "record-opener");
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "fixtures/record-opener.ts")],
    compile: { outfile: opener },
  });
  if (!build.success) throw new AggregateError(build.logs);
  peer = await buildPeer(dir);
}, 120000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
test("1. installed CLI verifies the environment and selected project executor", async () => {
  await disposableRelease(artifact, async (site) => {
    const daemon = startInstalled(site, "--print-pairing");
    try {
      const publication = await daemon.ready();
      const info = await daemon.next(pairingRecord);
      const { identity, principal } = await daemon.register();
      const device = await openDeviceCredentials(join(site.client, "device.sqlite"));
      try {
        const client = await connectDevice(new URL(info.url).origin, identity, device, principal);
        try {
          const project = accepted(
            await client.request({
              method: "project.register",
              commandId: commandId(),
              payload: { realPath: site.cwd },
            }),
            "projectRegistered",
          ).project;
          expect([project.environmentId, project.root?.realPath, project.id] as unknown[]).toEqual([
            client.configuration.environment.id,
            await realpath(site.cwd),
            new URLSearchParams(new URL(info.url).hash.slice(1)).get("projectId"),
          ]);
          const name = process.platform === "win32" ? "peer.exe" : "peer";
          await copyFile(peer, join(site.cwd, name));
          await copyFile(
            join(import.meta.dir, "../fixtures/executors/codex/basic-turn.jsonl"),
            join(site.cwd, "frames"),
          );
          const configured = accepted(
            await client.request({
              method: "executor.configure",
              commandId: commandId(),
              payload: {
                expectedVersion: null,
                registration: {
                  family: "codex",
                  instanceId: v.parse(ExecutorInstanceIdSchema, "installed-test"),
                  displayName: "Installed fixture",
                  enabled: true,
                  driver: {
                    executable: "./" + name,
                    endpoint: null,
                    configurationRoot: null,
                    historyRoot: null,
                    variables: {},
                  },
                  credential: null,
                  model: null,
                  permission: { selected: "ask", ceiling: "edits" },
                },
              },
            }),
            "executorConfigured",
          );
          const refreshed = accepted(
            await client.request({
              method: "executor.refresh",
              commandId: commandId(),
              payload: { projectId: project.id, instanceId: configured.instanceId },
            }),
            "executorRefreshed",
          );
          expect(refreshed).toMatchObject({
            displayName: "Installed fixture",
            enabled: true,
            instanceId: "installed-test",
            readiness: { installed: { state: "yes" } },
            binaryVersion: "0.156.0",
          });
          expect(await runIdentity(site)).toBe(publication.environmentId);
        } finally {
          client.close();
        }
      } finally {
        device.close();
      }
    } finally {
      await daemon.close();
    }
  });
}, 60000);
test("2. phone pairs by invitation and reconnects with its own permissions", async () => {
  await disposableRelease(artifact, async (site, dir) => {
    const daemon = startInstalled(site);
    try {
      const publication = await daemon.ready(),
        inv = await daemon.next(pairingRecord);
      const { identity, principal } = await daemon.register();
      const url = new URL(inv.url),
        params = new URLSearchParams(url.hash.slice(1));
      const phone = await openDeviceCredentials(join(dir, "phone", "device.sqlite"));
      try {
        const apply = () =>
          beginApplication(
            phone,
            url.origin,
            identity,
            v.parse(ProjectIdSchema, params.get("projectId")),
            v.parse(PairingInviteIdSchema, inv.inviteId),
            [...DEFAULT_DEVICE_PERMISSIONS],
          );
        const app = await apply();
        try {
          const summary = await daemon.next(PairingPendingSchema);
          expect(summary).toEqual(app.pending);
          await daemon.input("approve " + summary.requestId + " " + summary.confirmationCode);
          app.socket.send(await app.proof());
          const first = await daemon.next(PairingCompletedSchema);
          app.socket.close();
          const retry = await apply();
          try {
            expect(await daemon.next(PairingPendingSchema)).toEqual(summary);
            retry.socket.send(await retry.proof());
            const result = await retry.socket.result();
            expect(result).toEqual(first);
            const registered = retry.finish(result);
            expect(registered.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
            expect(registered.principal.id).not.toBe(principal.id);
            const client = await connectDevice(url.origin, identity, phone, registered.principal);
            try {
              expect(client.configuration.environment.id).toBe(publication.environmentId);
            } finally {
              client.close();
            }
            expect(
              await runIdentity({
                ...site,
                env: { ...site.env, KRAKA_CLIENT_DIR: join(dir, "phone") },
              }),
            ).toBe(identity.id);
          } finally {
            retry.socket.close();
          }
        } finally {
          app.socket.close();
        }
      } finally {
        phone.close();
      }
    } finally {
      await daemon.close();
    }
  });
}, 60000);
test("3. print and open use clean installations and reopen the installed CLI after reinstall", async () => {
  for (const mode of ["--print-pairing", "--open-browser"]) {
    await disposableRelease(artifact, async (site, dir) => {
      const log = join(dir, "opened.jsonl");
      await writeFile(log, "");
      const env = { ...site.env, KRAKA_URL_OPENER: opener, KRAKA_OPENER_RECORD: log };
      const daemon = startInstalled({ ...site, env }, mode);
      try {
        const publication = await daemon.ready();
        const readyCount = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).length;
        if (mode === "--print-pairing") {
          const info = await daemon.next(pairingRecord);
          expect(info.environmentId).toBe(publication.environmentId);
          expect(readyCount).toBe(0);
          await daemon.register();
          expect(await readFile(log, "utf8")).toBe("");
        } else {
          const prompt = await daemon.next(ownerPrompt);
          await daemon.next(v.strictObject({ kind: v.literal("browser.opened") }));
          const calls = (await readFile(log, "utf8"))
            .trim()
            .split("\n")
            .map((s) => new URL(JSON.parse(s)));
          expect(readyCount).toBeLessThanOrEqual(1);
          expect(calls).toHaveLength(1);
          const url = calls[0];
          if (!url) throw Error("Missing opener URL");
          expect(url.host).toBe(new URL(publication.endpoint).host);
          expect(new URLSearchParams(url.hash.slice(1)).get("environmentId")).toBe(
            publication.environmentId,
          );
          expect((await (await fetch(url)).text()).includes("startBrowserPage")).toBe(true);
          expect((await fetch(new URL("/assets/browser-host.js", url))).ok).toBe(true);
          await daemon.register(prompt);
          const link = new URLSearchParams(url.hash.slice(1));
          const identity = v.parse(EnvironmentIdentitySchema, {
            id: link.get("environmentId"),
            keyVersion: Number(link.get("keyVersion")),
            publicKey: link.get("publicKey"),
          });
          const device = await openDeviceCredentials(join(dir, "opened-device", "device.sqlite"));
          try {
            const app = await beginApplication(
              device,
              url.origin,
              identity,
              v.parse(ProjectIdSchema, link.get("projectId")),
              v.parse(PairingInviteIdSchema, link.get("inviteId")),
              ["thread.view"],
            );
            try {
              const pending = await daemon.next(PairingPendingSchema);
              expect(pending).toEqual(app.pending);
              await daemon.input("approve " + pending.requestId + " " + pending.confirmationCode);
              app.socket.send(await app.proof());
              const registered = app.finish(await app.socket.result());
              const session = await connectDevice(
                url.origin,
                identity,
                device,
                registered.principal,
              );
              try {
                expect(session.configuration.environment.id).toBe(publication.environmentId);
              } finally {
                session.close();
              }
            } finally {
              app.socket.close();
            }
          } finally {
            device.close();
          }
        }
        const extra = startInstalled({ ...site, env }, "--open-browser");
        try {
          const found = await extra.next(
            v.strictObject({
              kind: v.literal("existingInstance"),
              publication: InstancePublicationSchema,
            }),
          );
          expect(found.publication).toEqual(publication);
          expect(await extra.child.exited).toBe(0);
        } finally {
          await extra.close();
        }
        expect((await readFile(log, "utf8")).split("\n").filter(Boolean)).toHaveLength(
          mode === "--open-browser" ? 1 : 0,
        );
        expect(await installArtifact(artifact, join(dir, "prefix"))).toBe(site.bin);
        expect(await runIdentity(site)).toBe(publication.environmentId);
      } finally {
        await daemon.close();
      }
    });
  }
}, 60000);
