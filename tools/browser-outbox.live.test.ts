import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatchObservationMs } from "./fixtures/route-network";
import { X509Certificate, createHash } from "node:crypto";
import * as v from "valibot";
import {
  ProjectIdSchema,
  ThreadIdSchema,
  PairingPendingSchema,
  MessageIdSchema,
  type MessageId,
} from "@kraka/protocol";
import type { Page } from "playwright";
import { openDeviceCredentials } from "../packages/cli-client/src";
import type { InputOutbox, ThreadCache } from "../packages/client-runtime/src";
import {
  startTestHost,
  connectDevice,
  invite,
  approve,
  principalKey,
} from "./fixtures/paired-project";
import { certificate } from "./fixtures/browser-cert";
import { launchBrowserProfile, nativeBrowserSkipReason } from "./fixtures/browser-selection";
import { pin, phase } from "./fixtures/browser";
import { sampleRequest, within } from "./fixtures/replay-process";
import { tlsDial } from "./measure-browser";
import { choices, todoFor } from "./fixtures/todo";

type BrowserThread = {
  current: boolean;
  cache: ThreadCache;
  subscribe(listener: () => void): () => void;
  inspect(): ReturnType<InputOutbox["inspect"]>;
  flush(): ReturnType<InputOutbox["flushHead"]>;
  disconnect(): void;
  connect(): void;
};
const entry = "/assets/browser-host.js";
const text = sampleRequest.input.text;
const statusSchema = v.object({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  commands: v.array(v.string()),
  deliveries: v.array(v.string()),
  decisions: v.number(),
  receipts: v.array(v.object({ command: v.string(), position: v.number(), data: v.string() })),
});
async function inspect(page: Page) {
  return page.evaluate(async (path) => {
    const t: BrowserThread = (await import(path)).pageThread;
    return t.inspect();
  }, entry);
}
async function ready(page: Page, messageId?: MessageId) {
  await within(
    page.evaluate(
      async ({ path, id }) => {
        const t: BrowserThread = (await import(path)).pageThread;
        const done = () =>
          t.current &&
          (!id ||
            Object.values(t.cache.scopes).some((s) =>
              Object.values(s.members).some((k) => k.objectType === "message" && k.id === id),
            ));
        if (done()) return;
        await new Promise<void>((resolve) => {
          const off = t.subscribe(() => {
            if (done()) {
              off();
              resolve();
            }
          });
        });
      },
      { path: entry, id: messageId ?? null },
    ),
    12000,
    "matching thread seal",
  ).catch(async (e) => {
    throw Error(
      String(e) +
        " " +
        JSON.stringify(
          await page.evaluate(async (path) => {
            const t = (await import(path)).pageThread;
            return { status: t.status, error: t.error };
          }, entry),
        ),
    );
  });
}
async function rows(page: Page) {
  return page.evaluate(async (path) => {
    const t: BrowserThread = (await import(path)).pageThread;
    return Object.values(t.cache.rows).flatMap((r) => (r.row ? [r.row] : []));
  }, entry);
}
async function call(page: Page, action: "disconnect" | "connect" | "flush") {
  return page.evaluate(
    async ({ path, action }) => {
      const t: BrowserThread = (await import(path)).pageThread;
      return t[action]();
    },
    { path: entry, action },
  );
}
async function fixture(mode: "send" | "reject" | "approval") {
  const dir = await mkdtemp(join(tmpdir(), "kraka-browser-input-"));
  const cleanup: (() => void | Promise<void>)[] = [];
  async function close() {
    const errors: unknown[] = [];
    try {
      for (const dispose of cleanup.reverse()) {
        try {
          await dispose();
        } catch (e) {
          errors.push(e);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Browser fixture cleanup failed");
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }
  try {
    const cert = await certificate(dir);
    const certificatePin = createHash("sha256")
      .update(new X509Certificate(cert.ca).publicKey.export({ type: "spki", format: "der" }))
      .digest("base64");
    const peer = await startTestHost(dir, undefined, {
      host: "127.0.0.1",
      port: 0,
      certificate: cert.cert,
      privateKey: cert.key,
      outbox: mode,
    });
    cleanup.push(peer.stop);
    const ownerKey = await openDeviceCredentials(join(dir, "owner.sqlite"));
    cleanup.push(ownerKey.close);
    const ownerRecord = v.parse(
      principalKey,
      await peer.control("owner", {
        deviceId: ownerKey.deviceId,
        keyId: ownerKey.keyId,
        publicKey: ownerKey.publicKey,
      }),
    );
    const owner = await connectDevice(
      peer.origin,
      peer.identity,
      ownerKey,
      ownerRecord.principal,
      tlsDial(cert.ca, new Map()),
    );
    cleanup.push(owner.close);
    const status = async () => v.parse(statusSchema, await peer.control("outboxStatus"));
    const { projectId, threadId } = await status();
    async function profile(name: string) {
      const context = await launchBrowserProfile(join(dir, name), certificatePin);
      cleanup.push(() => context.close());
      async function tab(pair: boolean) {
        const page = await context.newPage();
        await page.goto(peer.origin);
        if (pair) {
          await pin(page, peer.identity);
          const invitation = await invite(owner, projectId);
          await page.getByLabel("Project ID").fill(projectId);
          await page.getByLabel("Invite ID").fill(invitation);
          for (const right of ["thread.view", "thread.send", "owner.decide"])
            await page.getByLabel(right, { exact: true }).check();
          await page.getByRole("button", { name: "Request pairing" }).click();
          await page.locator("#application").waitFor();
          const pending = v.parse(
            PairingPendingSchema,
            await page.evaluate(async (path) => (await import(path)).pagePairing, entry),
          );
          await approve(owner, pending);
        }
        await phase(page, "sendable");
        await page.getByLabel("Thread ID").fill(threadId);
        await page.getByRole("button", { name: "Open thread" }).click();
        await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
        return page;
      }
      return { context, tab };
    }
    return { peer, profile, status, threadId, close };
  } catch (e) {
    await close();
    throw e;
  }
}
async function enqueue(page: Page, body: string) {
  await page.getByLabel("Message", { exact: true }).fill(body);
  await page.getByRole("button", { name: "Send", exact: true }).click();
}
const skip = await nativeBrowserSkipReason();
if (skip && process.env.CI === "true") throw Error(skip);
if (skip) console.info(skip);
describe.skipIf(!!skip)("persistent browser outbox", () => {
  let f: Awaited<ReturnType<typeof fixture>>, phone: Page, desktop: Page, other: Page;
  let original: Awaited<ReturnType<typeof inspect>>["queue"]["items"][number];
  beforeAll(async () => {
    f = await fixture("send");
  }, 30000);
  afterAll(async () => {
    await f?.close();
  }, 30000);
  test("outbox 1. offline draft and queued input survive closing the last browser", async () => {
    const mobile = await f.profile("phone");
    phone = await mobile.tab(true);
    desktop = await (await f.profile("observer")).tab(true);
    await Promise.all([ready(phone), ready(desktop)]);
    await call(phone, "disconnect");
    await f.peer.control("outboxNetwork", { enabled: false });
    await enqueue(phone, text);
    await phone.getByRole("status").filter({ hasText: "Queued on this device" }).waitFor();
    const editor = phone.getByLabel("Message", { exact: true });
    await editor.evaluate((node) => {
      Object.assign(node, {
        committed: new Promise((resolve) =>
          node.addEventListener("kraka-draft-saved", () => resolve(true), { once: true }),
        ),
      });
    });
    await editor.fill("separate editable draft");
    await editor.evaluate((node) => Reflect.get(node, "committed"));
    original = (await inspect(phone)).queue.items[0]!;
    expect(original).toMatchObject({ order: 1, content: { text } });
    expect((await inspect(desktop)).drafts.current).toBeNull();
    expect((await inspect(desktop)).queue.items).toBeEmpty();
    expect((await rows(desktop)).filter((r) => r.objectType === "message")).toBeEmpty();
    await mobile.context.close();
    const reopen = await f.profile("phone");
    phone = await reopen.tab(false);
    other = await reopen.tab(false);
    for (const page of [phone, other]) {
      await call(page, "disconnect");
      expect((await inspect(page)).queue.items).toEqual([original]);
      expect((await inspect(page)).drafts.current?.content.text).toBe("separate editable draft");
      expect(
        await page.evaluate(async (path) => (await import(path)).pageThread.scope.threadId, entry),
      ).toBe(f.threadId);
    }
    expect((await rows(desktop)).filter((r) => r.objectType === "message")).toBeEmpty();
  }, 45000);
  test("outbox 2. two tabs retry the committed command and observe one native delivery", async () => {
    await f.peer.control("outboxNetwork", { enabled: true });
    await call(phone, "connect");
    await ready(phone);
    const commit = await f.peer.events.until(
      (e) => e.event === "commandCommitted" && e.dropped === true,
    );
    expect(commit.commandId).toBe(original.commandId);
    const messageId = v.parse(MessageIdSchema, commit.messageId);
    await ready(desktop, messageId);
    await call(phone, "disconnect");
    await Promise.all([call(phone, "connect"), call(other, "connect")]);
    const retry = await f.peer.events.until(
      (e) => e.event === "commandCommitted" && e.dropped === false,
    );
    expect(retry.epoch).not.toBe(commit.epoch);
    expect(retry.position).toBe(commit.position);
    await Promise.all([ready(phone, messageId), ready(other, messageId)]);
    const attempts = [phone, other].map(async (page) => {
      // Install the promise in each tab before the peer releases the numbered reply.
      await page.evaluate(async (path) => {
        const t = (await import(path)).pageThread;
        Reflect.set(globalThis, "outboxFlush", t.flush());
      }, entry);
    });
    await Promise.all(attempts);
    await f.peer.control("outboxRelease");
    await Promise.all(
      [phone, other].map((page) => page.evaluate(() => Reflect.get(globalThis, "outboxFlush"))),
    );
    const [native, started] = await Promise.all([
      f.peer.event("nativeInput", dispatchObservationMs),
      f.peer.event("started", dispatchObservationMs),
    ]);
    const state = await f.status();
    expect(state.commands).toEqual([original.commandId, original.commandId]);
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]?.position).toBe(v.parse(v.number(), commit.position));
    expect(state.deliveries).toEqual([native.id as string]);
    const receipt = JSON.parse(state.receipts[0]!.data);
    expect(receipt.result).toMatchObject({
      messageId,
      deliveryId: native.id,
      roundId: started.roundId,
    });
    expect(typeof started.startedAt).toBe("number");
    expect(
      (await rows(desktop)).filter((r) => r.objectType === "message").map((r) => r.value.id),
    ).toEqual([messageId]);
    const saved = await inspect(phone);
    expect(saved.receipts.bindings[original.commandId]).toBe(messageId);
    expect(saved.queue.items).toBeEmpty();
    expect(saved.drafts.current?.content.text).toBe("separate editable draft");
  }, 45000);
});
test.skipIf(!!skip)(
  "outbox 3. rejected ordinary input becomes editable on its device",
  async () => {
    const f = await fixture("reject");
    try {
      const p = await (await f.profile("phone")).tab(true);
      await ready(p);
      await call(p, "disconnect");
      await enqueue(p, " exact\ntext ");
      await p.getByText("Queued on this device", { exact: true }).waitFor();
      const head = (await inspect(p)).queue.items[0]!;
      await call(p, "connect");
      await p.getByText("Draft saved on this device", { exact: true }).waitFor();
      expect((await inspect(p)).drafts.current?.content.text).toBe(" exact\ntext ");
      expect(await p.getByLabel("Message", { exact: true }).inputValue()).toBe(" exact\ntext ");
      await call(p, "flush");
      expect((await inspect(p)).queue.items).toBeEmpty();
      expect((await f.status()).commands).toEqual([head.commandId]);
    } finally {
      await f.close();
    }
  },
  45000,
);
test.skipIf(!!skip)(
  "outbox 4. an offline approval stays open on the observer",
  async () => {
    const f = await fixture("approval");
    try {
      const p = await (await f.profile("phone")).tab(true),
        observer = await (await f.profile("desktop")).tab(true);
      await Promise.all([ready(p), ready(observer)]);
      const todo = todoFor("approval"),
        payload = { threadId: f.threadId, todoRequestId: todo.id, decision: choices[0]! };
      await call(p, "disconnect");
      expect(
        await p.evaluate(
          async ({ path, payload }) => (await import(path)).pageThread.decide(payload),
          { path: entry, payload },
        ),
      ).toBeNull();
      expect((await inspect(p)).queue.items).toBeEmpty();
      expect(
        (await rows(observer)).find(
          (r) => r.objectType === "todoRequest" && r.value.id === todo.id,
        ),
      ).toMatchObject({ value: { state: { kind: "open" } } });
      await call(p, "connect");
      await ready(p);
      await call(p, "flush");
      expect((await f.status()).decisions).toBe(0);
    } finally {
      await f.close();
    }
  },
  45000,
);
