import { expect, test } from "bun:test";
import { certificate } from "./fixtures/browser-cert";
import { join } from "node:path";
import { within, withState, terminate } from "./fixtures/replay-process";
import { invite, approve } from "./fixtures/paired-project";
import { openBrowserFixture, pin, phase, readInvites, snapshot } from "./fixtures/browser";
import { ProjectIdSchema } from "@kraka/protocol";
import * as v from "valibot";

export { startBrowserFixture } from "./fixtures/browser";
const native = (process.env.KRAKA_BROWSER_CASES ?? "native") === "native";
const run = (
  name: string,
  fn: (f: Awaited<ReturnType<typeof openBrowserFixture>>, dir: string) => Promise<void>,
) =>
  test(
    name,
    () =>
      withState(async (dir) => {
        const f = await openBrowserFixture({
          stateDir: dir,
          profileDir: join(dir, "profile"),
          network: "loopback",
        });
        try {
          await fn(f, dir);
        } finally {
          await f.close();
        }
      }),
    45000,
  );
if (native) {
  run("native 1. listener preflight and both module pages", async (f, dir) => {
    const good = await certificate(dir),
      other = await certificate(dir, "other", "DNS:other.invalid");
    for (const [opts, stage, reason] of [
      [["--tls-cert", good.cert], "transport", "incompleteTlsPair"],
      [["--tls-cert", good.cert, "--tls-key", other.key], "privateKey", "keyMismatch"],
      [["--tls-cert", other.cert, "--tls-key", other.key], "certificate", "nameMismatch"],
      [
        ["--tls-cert", join(dir, "missing"), "--tls-key", other.key],
        "certificate",
        "unusableCertificate",
      ],
      [["--tls-cert", good.cert, "--tls-key", join(dir, "missing")], "privateKey", "unusableKey"],
      [
        ["--tls-cert", good.cert, "--tls-key", other.key, "--public-origin", "http://localhost"],
        "origin",
        "protocolMismatch",
      ],
      [["--listen", "0.0.0.0"], "transport", "missingTls"],
    ] as const) {
      const child = Bun.spawnSync([
        process.execPath,
        "packages/daemon/src/index.ts",
        "daemon",
        "--state-dir",
        join(dir, "preflight"),
        "--listen",
        "127.0.0.1",
        "--port",
        "0",
        ...opts,
      ]);
      expect(child.exitCode).not.toBe(0);
      expect(child.stdout.toString()).toBe("");
      expect(JSON.parse(child.stderr.toString())).toMatchObject({ kind: "failed", stage, reason });
    }
    const built = Bun.spawnSync([
      process.execPath,
      "run",
      "--filter",
      "@kraka/browser-host",
      "build",
    ]);
    expect(built.exitCode).toBe(0);
    const bundle = await Bun.file(".build/packages/browser-host.js").text();
    expect(bundle).toContain("openBrowserSession");
    expect(bundle).not.toContain("/__fixture__/");
    const html = await (await fetch(f.origin)).text();
    const fixture = await (await fetch(`${f.origin}/__fixture__/browser.html`)).text();
    for (const body of [html, fixture]) expect(body).toContain('from "/assets/browser-host.js"');
    const js = await fetch(`${f.origin}/assets/browser-host.js`);
    expect(js.status).toBe(200);
    expect(await js.clone().text()).toBe(bundle);
    const app = Bun.spawn(
      [
        process.execPath,
        "packages/daemon/src/index.ts",
        "daemon",
        "--state-dir",
        join(dir, "release"),
        "--listen",
        "127.0.0.1",
        "--port",
        "0",
      ],
      { stdout: "pipe", stderr: "pipe" },
    );
    try {
      const reader = app.stdout.getReader();
      const first = await within(reader.read(), 3000, "release ready");
      const ready = JSON.parse(new TextDecoder().decode(first.value));
      expect(ready.kind).toBe("ready");
      expect((await fetch(`${ready.origin}/__fixture__/browser.html`)).status).toBe(404);
      expect(await (await fetch(`${ready.origin}/assets/browser-host.js`)).text()).toEqual(
        await js.text(),
      );
    } finally {
      await terminate(app);
    }
  });
  run("native 2. verified identity and authorized read gates", async (f) => {
    const before = await pin(f.page, f.project.identity);
    expect(before).toMatchObject({
      phase: "helloVerified",
      identity: f.project.identity,
      unpairedReason: "notRegistered",
    });
    const early = await readInvites(f.page, f.project.projectId);
    expect(early.result).toMatchObject({
      kind: "unavailable",
      commandId: early.commandId,
      snapshot: before,
    });
    expect(await f.page.evaluate("browserEvidence.counts")).toMatchObject({
      business: 0,
      authentication: 0,
      discovery: 0,
    });
    const pending = await f.apply();
    await f.project.host.control("holdConfiguration");
    await approve(f.project.owner, pending);
    const waiting = await phase(f.page, "authorizedAwaitingConfiguration");
    const blocked = await readInvites(f.page, f.project.projectId);
    expect(blocked.result).toMatchObject({
      kind: "unavailable",
      commandId: blocked.commandId,
      snapshot: waiting,
    });
    expect(await f.page.evaluate("browserEvidence.counts.business")).toBe(0);
    await f.project.host.control("releaseConfiguration");
    await phase(f.page, "sendable");
    const seed = await invite(f.project.owner, f.project.projectId);
    const fresh = await readInvites(f.page, f.project.projectId);
    expect(fresh.result).toMatchObject({
      kind: "receipt",
      receipt: {
        kind: "accepted",
        result: { kind: "invitesListed", invites: [{ inviteId: seed }] },
      },
    });
    const events = f.project.host.events.items.filter((e) => e.deviceId === pending.deviceId);
    expect(
      events.filter((e) => e.kind === "receivedBusiness").map((e) => [e.sequence, e.commandId]),
    ).toEqual([[2, fresh.commandId]]);
    await f.page.evaluate('browserEvidence.hold="business"');
    const interrupted = readInvites(f.page, f.project.projectId);
    await f.page.waitForFunction("typeof browserEvidence.release === 'function'");
    await f.page.evaluate(
      'import("/assets/browser-host.js").then(m=>{m.pageSession.close();m.pageSession.close();browserEvidence.release();})',
    );
    expect((await interrupted).result).toMatchObject({
      kind: "unavailable",
      snapshot: { phase: "closed" },
    });
    expect(
      f.project.host.events.items.filter(
        (e) => e.deviceId === pending.deviceId && e.kind === "receivedBusiness",
      ),
    ).toHaveLength(1);
    const [restarted] = await Promise.all([
      f.restart(),
      f.project.host.control("advance", { ms: 2592000001 }),
    ]);
    await restarted.getByText(/keyExpired/).waitFor();
    expect(await snapshot(restarted)).toMatchObject({
      phase: "failed",
      failure: {
        reason: { kind: "authenticationRejected", reason: "keyExpired" },
        diagnostic: { detail: { stage: "authentication", reason: "keyExpired" } },
      },
    });
  });
  run("native 3. project grant, denied control project and Chromium restart", async (f) => {
    const app = await f.pair();
    const seed = await invite(f.project.owner, f.project.projectId);
    expect((await readInvites(f.page, f.project.projectId)).result).toMatchObject({
      kind: "receipt",
      receipt: {
        kind: "accepted",
        result: { kind: "invitesListed", invites: [{ inviteId: seed }] },
      },
    });
    const rights = await f.page.evaluate(async (projectId) => {
      const path = "/assets/browser-host.js",
        m = await import(path),
        handle = m.pageSession;
      const r = await handle.read({
        commandId: crypto.randomUUID(),
        method: "access.listGrants",
        payload: { target: { kind: "project", projectId }, after: null },
      });
      if (
        r.kind !== "receipt" ||
        r.receipt.kind !== "accepted" ||
        r.receipt.result.kind !== "grantsListed"
      )
        throw Error("Grant listing denied");
      const principal = handle.snapshot().authorization.principal;
      return {
        principal,
        permissions: r.receipt.result.grants
          .filter((g: { principalId: string }) => g.principalId === principal.id)
          .map((g: { permission: string }) => g.permission)
          .sort(),
      };
    }, f.project.projectId);
    expect(rights).toMatchObject({
      principal: { deviceId: app.deviceId },
      permissions: ["access.give", "thread.view"],
    });
    const control = v.parse(ProjectIdSchema, "control");
    await f.project.host.control("project", { projectId: control, threadId: "control-thread" });
    expect((await readInvites(f.page, control)).result).toMatchObject({
      kind: "receipt",
      receipt: { kind: "rejected", failure: { kind: "missingPermission" } },
    });
    for (let i = 0; i < 8; i++) await invite(f.project.owner, f.project.projectId);
    const long = (await readInvites(f.page, f.project.projectId)).result;
    expect(long).toMatchObject({
      kind: "receipt",
      receipt: { kind: "accepted", result: { kind: "invitesListed", next: expect.any(String) } },
    });
    if (
      long.kind !== "receipt" ||
      long.receipt.kind !== "accepted" ||
      long.receipt.result.kind !== "invitesListed"
    )
      throw Error("Missing paginated result");
    expect(long.receipt.result.invites).toHaveLength(8);
    const before = await snapshot(f.page);
    await f.restart();
    const again = await phase(f.page, "sendable");
    expect(again).toMatchObject({
      identity: f.project.identity,
      authorization: { principal: { deviceId: app.deviceId } },
    });
    if (before.phase !== "sendable" || again.phase !== "sendable")
      throw Error("Device lost authorization");
    expect(again.connectionId).not.toEqual(before.connectionId);
  });
  run("native 4. resume pending application with original nonextractable key", async (f, dir) => {
    await pin(f.page, f.project.identity);
    const pending = await f.apply();
    await f.restart();
    await f.project.host.control("lose");
    await approve(f.project.owner, pending);
    await f.project.host.event("lostReply");
    await f.restart(
      'const orig=IDBObjectStore.prototype.put;IDBObjectStore.prototype.put=function(row,...args){const r=orig.call(this,row,...args);if(row?.kind==="registered")this.transaction.abort();return r;};',
    );
    await f.project.host.control("resumeReply");
    await f.page.getByText(/storageUnavailable/).waitFor();
    const interrupted = await f.page.evaluate(
      (env) => Reflect.get(globalThis, "inspectDevice")(env),
      f.project.identity.id,
    );
    expect(interrupted).toMatchObject({
      kind: "pendingExchange",
      requestId: pending.requestId,
      deviceId: pending.deviceId,
      claimId: expect.any(String),
      count: 1,
      extractable: false,
    });
    await f.restart();
    const authority = await phase(f.page, "sendable");
    expect(authority).toMatchObject({
      authorization: { principal: { deviceId: pending.deviceId } },
    });
    expect(await f.project.host.control("deviceCount", { deviceId: pending.deviceId })).toEqual({
      count: 1,
    });
    const env = f.project.identity.id;
    const inspect = (mode?: string) =>
      f.page.evaluate(
        ([env, change]) => Reflect.get(globalThis, "inspectDevice")(env, change),
        [env, mode],
      );
    expect(await inspect()).toMatchObject({
      kind: "registered",
      deviceId: pending.deviceId,
      count: 1,
      extractable: false,
      permissions: pending.permissions,
    });
    // Copy only after Chromium exits so each storage fault starts from an identical committed profile.
    const { cp } = await import("node:fs/promises");
    const { chromium } = await import("playwright");
    const alternate = f.origin.replace("127.0.0.1", "localhost");
    const otherPage = await f.context.newPage();
    await otherPage.goto(alternate);
    expect(
      await otherPage.evaluate(
        async ({ origin, env }) => {
          const path = "/assets/browser-host.js",
            m = await import(path);
          return {
            catalog: await m.readBrowserCatalog(),
            registration: (
              await m.createBrowserCredentials({ origin, environmentId: env }).discover(env)
            ).kind,
          };
        },
        { origin: alternate, env },
      ),
    ).toEqual({
      catalog: { kind: "ready", catalog: { formatVersion: 1, environments: [] } },
      registration: "notRegistered",
    });
    await otherPage.close();
    const save = join(dir, "saved-profile");
    await f.context.close();
    await cp(join(dir, "profile"), save, { recursive: true });
    for (const [change, expected] of [
      ["missing", "keyMissing"],
      ["unusable", "keyUnusable"],
      ["corrupt", "corruptRecord"],
      ["unavailable", "storageUnavailable"],
      ["cleared", "notRegistered"],
    ] as const) {
      const profile = join(dir, change);
      if (change !== "cleared") await cp(save, profile, { recursive: true });
      const c = await chromium.launchPersistentContext(profile);
      try {
        const page = c.pages()[0] ?? (await c.newPage());
        await page.addInitScript({
          path: join(import.meta.dir, "fixtures/browser-observations.js"),
        });
        // The fixture page imports the same module without opening a second registered connection here.
        await page.goto(`${f.origin}/__fixture__/browser.html`);
        if (["missing", "corrupt", "unusable"].includes(change))
          await page.evaluate(
            ([env, mode]) => Reflect.get(globalThis, "inspectDevice")(env, mode),
            [env, change],
          );
        if (change === "unavailable")
          await page.evaluate(
            'Object.defineProperty(globalThis,"indexedDB",{get(){throw Error("Fixture storage unavailable");}})',
          );
        const discovery = await page.evaluate(
          async ({ env, origin }) => {
            const path = "/assets/browser-host.js",
              m = await import(path);
            return (await m.createBrowserCredentials({ origin, environmentId: env }).discover(env))
              .kind;
          },
          { env, origin: f.origin },
        );
        expect(discovery).toBe(expected);
      } finally {
        await c.close();
      }
    }
  });
}
if (process.env.KRAKA_BROWSER_CASES === "routed") {
  const networkCase = (
    name: string,
    fn: (f: Awaited<ReturnType<typeof openBrowserFixture>>) => Promise<void>,
  ) =>
    test(
      name,
      () =>
        withState(async (dir) => {
          const f = await openBrowserFixture({
            stateDir: dir,
            profileDir: join(dir, "profile"),
            network: "routed",
          });
          try {
            await fn(f);
          } finally {
            await f.close();
          }
        }),
      90000,
    );
  networkCase("routed 1. same device signs from LAN and routed subnet", async (f) => {
    const pending = await f.pair(),
      seed = await invite(f.project.owner, f.project.projectId);
    const { samplePath } = await import("./fixtures/browser-path");
    const lan = await samplePath(f.page, f.project.identity, f.origin, f.project.projectId, seed);
    await f.restore();
    const route = JSON.parse(await f.route());
    expect(route[0].gateway).toBe("10.78.42.2");
    await f.disconnect();
    await expect(f.route()).rejects.toThrow();
    const failure = await f.page.evaluate(
      async ({ identity, origin }) => {
        const path = "/assets/browser-host.js",
          m = await import(path);
        const h = m.openBrowserSession({
          pageOrigin: origin,
          expectedIdentity: identity,
          routeCatalog: (await m.readBrowserCatalog()).catalog,
          credentials: m.createBrowserCredentials({ origin, environmentId: identity.id }),
          socketFactory: m.browserSocketFactory,
        });
        try {
          return await new Promise((resolve) =>
            h.subscribe((s: { phase: string }) => {
              if (s.phase === "failed") resolve(s);
            }),
          );
        } finally {
          h.close();
        }
      },
      { identity: f.project.identity, origin: f.origin },
    );
    expect(failure).toMatchObject({ phase: "failed", failure: { reason: "noResponse" } });
    await f.restore();
    const routed = await samplePath(
      f.page,
      f.project.identity,
      f.origin,
      f.project.projectId,
      seed,
    );
    for (const [name, rows, address] of [
      ["LAN", lan, "10.78.41.11"],
      ["routed", routed, "10.78.42.11"],
    ] as const) {
      expect(rows).toHaveLength(10);
      for (const row of rows) {
        expect(row.device).toMatchObject({ deviceId: pending.deviceId });
        expect(f.project.host.events.items).toContainEqual(
          expect.objectContaining({ kind: "hello", connectionId: row.connectionId, address }),
        );
        expect(f.project.host.events.items).toContainEqual(
          expect.objectContaining({
            kind: "accepted",
            connectionId: row.connectionId,
            deviceId: pending.deviceId,
            commandId: row.commandId,
            sequence: 2,
          }),
        );
      }
      const median = (values: number[]) => {
        values.sort((a, b) => a - b);
        return ((values[4] ?? NaN) + (values[5] ?? NaN)) / 2;
      };
      const signing = v.parse(
        v.array(v.object({ commandId: v.nullish(v.string()), ms: v.number() })),
        await f.page.evaluate("browserEvidence.signing"),
      );
      const spans = rows.map((row) => {
        const events = f.project.host.events.items.filter(
          (e) => e.connectionId === row.connectionId && e.sequence === 2,
        );
        const at = (kind: string) => v.parse(v.number(), events.find((e) => e.kind === kind)?.at);
        return {
          commandId: row.commandId,
          signMs: v.parse(v.number(), signing.find((s) => s.commandId === row.commandId)?.ms),
          verifyMs: at("proof") - at("receivedBusiness"),
          commitMs: at("accepted") - at("proof"),
        };
      });
      console.log(
        JSON.stringify({
          spans,
          path: name,
          address,
          route: name === "routed" ? route : "on-link",
          count: rows.length,
          medianHandshake: median(rows.map((r) => r.times.sendable - r.times.dial)),
          medianRead: median(rows.map((r) => r.times.receipt - r.times.submit)),
          rows,
        }),
      );
    }
  });
  for (const [i, placement] of ["LAN", "routed"].entries())
    networkCase(`routed ${i + 2}. insecure HTTP on ${placement}`, async (f) => {
      const { browserAssets } = await import("../packages/daemon/src/browser-listener");
      const asset = await browserAssets();
      let upgrades = 0;
      const server = Bun.serve({
        hostname: "0.0.0.0",
        port: 0,
        fetch(req) {
          if (req.headers.has("upgrade")) upgrades++;
          return new URL(req.url).pathname === "/assets/browser-host.js"
            ? new Response(asset, { headers: { "Content-Type": "text/javascript" } })
            : new Response('<script type="module" src="/assets/browser-host.js"></script>', {
                headers: { "Content-Type": "text/html" },
              });
        },
      });
      try {
        if (placement === "routed") await f.restore();
        const route = JSON.parse(await f.route());
        expect(route[0].prefsrc).toBe(placement === "LAN" ? "10.78.41.11" : "10.78.42.11");
        const origin = `http://kraka.test:${server.port}`;
        await f.page.goto(origin);
        const facts = await f.page.evaluate(
          async ({ identity, origin, projectId }) => {
            const path = "/assets/browser-host.js",
              m = await import(path),
              commandId = "insecure-read";
            const credentials = m.createBrowserCredentials({ origin, environmentId: identity.id });
            const platform = m.createBrowserPlatform(credentials, m.browserSocketFactory);
            const routeCatalog = {
              formatVersion: 1,
              environments: [
                {
                  environmentId: identity.id,
                  pinnedIdentity: identity,
                  preferredRouteId: "prior",
                  routes: [
                    {
                      environmentId: identity.id,
                      id: "prior",
                      kind: "lan",
                      endpoint: origin,
                      status: { kind: "untested" },
                      lastObservedSecureContext: true,
                    },
                  ],
                },
              ],
            };
            await platform.state.commit([
              {
                key: "routeCatalog",
                value: new TextEncoder().encode(JSON.stringify(routeCatalog)),
              },
            ]);
            const handle = m.openBrowserSession({
              pageOrigin: origin,
              expectedIdentity: identity,
              routeCatalog,
              credentials,
              socketFactory: m.browserSocketFactory,
            });
            await Promise.resolve();
            const result = await handle.read({
              commandId,
              method: "device.pairing.listInvites",
              payload: { target: { kind: "project", projectId }, after: null },
            });
            handle.close();
            return {
              result,
              secure: Reflect.get(globalThis, "isSecureContext"),
              subtle: !!globalThis.crypto?.subtle,
              counts: Reflect.get(globalThis, "browserEvidence").counts,
            };
          },
          { identity: f.project.identity, origin, projectId: f.project.projectId },
        );
        expect(facts).toMatchObject({
          secure: false,
          subtle: false,
          result: {
            kind: "unavailable",
            snapshot: { phase: "failed", failure: { reason: "insecureContext" } },
          },
          counts: { business: 0, authentication: 0 },
        });
        expect(upgrades).toBe(0);
      } finally {
        await server.stop(true);
      }
    });
  networkCase("routed 4. untrusted CA fails before document load", async (f) => {
    await f.restore();
    let pages = 0;
    const server = Bun.serve({
      hostname: "0.0.0.0",
      port: 0,
      tls: { cert: Bun.file("/fixture/other-leaf.pem"), key: Bun.file("/fixture/other-leaf.key") },
      fetch() {
        pages++;
        return new Response("unexpected");
      },
    });
    try {
      await expect(f.page.goto(`https://kraka.test:${server.port}`)).rejects.toThrow(
        "ERR_CERT_AUTHORITY_INVALID",
      );
      expect(pages).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
  for (const mode of ["changed", "foreign"] as const)
    networkCase(
      "routed " +
        (mode === "changed"
          ? "5. pinned key mismatch"
          : "6. verified foreign environment and silent peer"),
      async (f) => {
        const pending = await f.pair();
        await f.restore();
        await f.project.host.control("peer", { mode });
        const since = f.project.host.events.items.length;
        await f.restart(undefined, true);
        const failed = await (async () => {
          await f.page.getByText(/wrongEnvironment|pinnedKeyMismatch/).waitFor();
          return snapshot(f.page);
        })();
        expect(failed).toMatchObject({
          phase: "failed",
          failure:
            mode === "changed"
              ? {
                  stage: "route",
                  diagnostic: {
                    detail: { stage: "environmentIdentity", reason: "pinnedKeyMismatch" },
                  },
                }
              : {
                  stage: "route",
                  reason: { kind: "wrongEnvironment", actualEnvironmentId: "other-environment" },
                },
        });
        expect(
          f.project.host.events.items
            .slice(since)
            .filter((e) => e.kind === "receivedProof" && e.deviceId === pending.deviceId),
        ).toHaveLength(0);
        if (mode === "foreign") {
          await f.project.host.control("peer", { mode: "silent" });
          await f.page.reload();
          await f.page.getByText(/noResponse/).waitFor();
          expect(await snapshot(f.page)).toMatchObject({
            phase: "failed",
            failure: { stage: "route", reason: "noResponse" },
          });
        }
      },
    );
}
