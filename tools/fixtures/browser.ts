import { mobile, routedBrowser } from "./browser-routed";
import { chromium, type Page } from "playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import {
  PairingPendingSchema,
  canonicalJson,
  CommandIdSchema,
  type EnvironmentIdentity,
  type ProjectId,
} from "@kraka/protocol";
import { startPairedProject, invite, approve, pendingFor } from "./paired-project";
import type { SessionSnapshot, OnlineReadResult } from "../../packages/client-runtime/src";
import { CommandReceiptSchema } from "@kraka/protocol";

export const modulePath = "/assets/browser-host.js";
export async function snapshot(page: Page): Promise<SessionSnapshot> {
  return page.evaluate('import("/assets/browser-host.js").then(m=>m.pageSession?.snapshot())');
}
export async function phase(page: Page, phase: SessionSnapshot["phase"]) {
  await page.locator("output").getByText(phase, { exact: true }).waitFor({ timeout: 10000 });
  return snapshot(page);
}
export async function pin(page: Page, identity: EnvironmentIdentity) {
  await page.getByLabel("Environment ID").fill(identity.id);
  await page.getByLabel("Public key").fill(identity.publicKey);
  await page.getByLabel("Key version").fill(String(identity.keyVersion));
  await page.getByRole("button", { name: "Confirm host" }).click();
  return phase(page, "helloVerified");
}
export async function readInvites(page: Page, projectId: ProjectId) {
  const commandId = v.parse(CommandIdSchema, crypto.randomUUID());
  const result: OnlineReadResult = await page.evaluate(
    async ({ commandId, projectId }) => {
      const path = "/assets/browser-host.js";
      const m = await import(path);
      return m.pageSession.read({
        commandId,
        method: "device.pairing.listInvites",
        payload: { target: { kind: "project", projectId }, after: null },
      });
    },
    { commandId, projectId },
  );
  if (result.kind === "receipt") {
    const receipt = v.parse(CommandReceiptSchema, result.receipt);
    if (receipt.commandId !== commandId) throw Error("Receipt belongs to another read");
  } else if (result.commandId !== commandId) throw Error("Lost command ID");
  return { commandId, result };
}
export async function startBrowserFixture({
  stateDir,
  profileDir,
  network,
}: {
  stateDir: string;
  profileDir: string;
  network: "loopback" | "routed";
}) {
  await mkdir(stateDir, { recursive: true });
  const browser =
    network === "loopback"
      ? { host: "127.0.0.1", port: 0 }
      : {
          host: "0.0.0.0",
          port: 8443,
          publicOrigin: "https://kraka.test:8443",
          certificate: "/fixture/leaf.pem",
          privateKey: "/fixture/leaf.key",
        };
  const project = await startPairedProject({ stateDir, projectId: "P", requests: [], browser });
  const origin = project.host.origin;
  const remote =
    network === "routed"
      ? await routedBrowser(profileDir).catch(async (e) => {
          await project.close();
          throw e;
        })
      : null;
  const launch = async () => {
    if (remote) return remote.launch();
    const context = await chromium.launchPersistentContext(profileDir, { headless: true });
    return { context, close: () => context.close() };
  };
  let client = await launch().catch(async (error) => {
    await remote?.close();
    await project.close();
    throw error;
  });
  async function open() {
    const context = client.context;
    await context.addInitScript({ path: join(import.meta.dir, "browser-observations.js") });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(origin);
    await page.getByRole("button", { name: "Confirm host" }).waitFor();
    return page;
  }
  try {
    let page = await open();
    async function restart(init?: string, copyProfile = false) {
      await client.close();
      if (copyProfile && remote) await remote.forkProfile();
      client = await launch();
      if (init) await client.context.addInitScript(init);
      page = await open();
      return page;
    }
    async function apply() {
      const invitation = await invite(project.owner, project.projectId);
      const since = project.host.events.items.length;
      await page.getByLabel("Project ID").fill(project.projectId);
      await page.getByLabel("Invite ID").fill(invitation);
      await page.getByLabel("thread.view").check();
      await page.getByLabel("access.give").check();
      await page.getByRole("button", { name: "Request pairing" }).click();
      await project.host.events.until((e) => e.kind === "applied", since);
      const [pending] = await pendingFor(project.owner, project.projectId, invitation);
      if (!pending) throw Error("Browser application missing");
      await page.locator("#application").waitFor();
      const shown = v.parse(
        PairingPendingSchema,
        await page.evaluate('import("/assets/browser-host.js").then(m=>m.pagePairing)'),
      );
      if (canonicalJson(shown) !== canonicalJson(pending))
        throw Error("Owner and browser see different applications");
      return shown;
    }
    return {
      origin,
      project,
      get page() {
        return page;
      },
      get context() {
        return client.context;
      },
      route: () => mobile("/route"),
      disconnect: () => mobile("/disconnect"),
      restore: () => mobile("/routed"),
      lan: () => mobile("/lan"),
      restart,
      apply,
      async pair() {
        await pin(page, project.identity);
        const pending = await apply();
        await approve(project.owner, pending);
        await phase(page, "sendable");
        return pending;
      },
      async close() {
        try {
          await client.close();
        } finally {
          await remote?.close();
          await project.close();
        }
      },
    };
  } catch (error) {
    try {
      await client.close();
    } finally {
      await remote?.close();
      await project.close();
    }
    throw error;
  }
}
