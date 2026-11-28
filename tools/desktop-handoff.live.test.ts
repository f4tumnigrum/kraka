import type { ThreadCache } from "../packages/client-runtime/src";
import type { InstalledThread } from "../packages/client-runtime/hosts/native-thread";
import { beforeAll, afterAll, describe, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright";
import * as v from "valibot";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  DESKTOP_IPC,
  PairingPendingSchema,
  PairingCompletedSchema,
  MessageIdSchema,
  HistoryPageSchema,
  SyncCursorSchema,
  TodoReplyRecordSchema,
  type TodoReplyRecord,
  type TodoRequestId,
  type MessageId,
  type DeviceId,
  type SubscriptionId,
  type SyncPosition,
} from "@kraka/protocol";
import { hostRelease, installedDirectory, runIdentity } from "./fixtures/installed";
import { installArtifact } from "./package-release";
import { handoffHost, installedFollow } from "./fixtures/handoff-host";
import { installDesktop, launchInstalledDesktop } from "./fixtures/installed-desktop";
import { handoffOrigin, handoffRoute } from "./fixtures/handoff-route";
import { pin, phase, modulePath } from "./fixtures/browser";
import { mobile, routedBrowser } from "./fixtures/browser-routed";
import { approve } from "./fixtures/paired-project";
import { within } from "./fixtures/replay-process";

const selected = process.env.KRAKA_DESKTOP_CASES;
const native = process.env.CI === "true" && selected === "native";
const routed =
  process.env.CI === "true" && selected === "routed" && process.env.KRAKA_FIXTURE_DESKTOP === "1";
if (selected && !native && !routed) throw Error("Missing required Electron CI fixture");
if (!native && !routed) console.info("Electron 只在 CI 运行");

async function setup(dir: string, remote: boolean) {
  const prefix = join(dir, "prefix"),
    artifact = await hostRelease(dir);
  const site = await installedDirectory(dir, await installArtifact(artifact, prefix));
  await installDesktop(prefix);
  const host = await handoffHost(site, dir, remote ? handoffOrigin : undefined);
  try {
    const profileDir = join(dir, "desktop-profile");
    const registered = await host.pairProfile(profileDir);
    const args = {
      installPrefix: prefix,
      profileDir,
      stateDir: site.state,
      environmentId: host.identity.id,
      threadId: host.initial.threadId,
    };
    const desktop = await launchInstalledDesktop(args);
    return { host, site, desktop, registered, args };
  } catch (e) {
    await host.close();
    throw e;
  }
}

test.skipIf(!native)(
  "installed desktop launches, rejects foreign windows, and preserves the foreground owner (routing delegated)",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "kraka-desktop-"));
    try {
      const { host, site, desktop, registered, args } = await setup(dir, false);
      try {
        expect(desktop.deviceId).toBe(registered.deviceId);
        expect(
          desktop.first.rows.some((r) => r.objectType === "thread" && r.value.id === args.threadId),
        ).toBe(true);
        const bridge = await desktop.page.evaluate(async ({ environmentId, threadId }) => {
          const b = Reflect.get(globalThis, "desktop");
          let invalid = false;
          try {
            await b.connectRoute({
              environmentId,
              routeId: environmentId + "-local",
              address: "extra",
            });
          } catch {
            invalid = true;
          }
          return {
            methods: Object.keys(b).sort(),
            invalid,
            unknown: await b.connectRoute({ environmentId, routeId: "absent" }),
            focus: await b.focusThread({ environmentId, threadId }),
            stop: await b.localEnvironment({ action: "stopOwned" }),
          };
        }, args);
        expect(bridge).toEqual({
          methods: Object.keys(DESKTOP_IPC).sort(),
          invalid: true,
          unknown: "unavailable",
          focus: { kind: "done" },
          stop: "externallyOwned",
        });
        expect(await desktop.foreignWindowDenied()).toBe(true);
        console.info(
          JSON.stringify({
            electron: desktop.main.electron,
            chromium: desktop.main.chromium,
            mainPid: desktop.main.pid,
            routing: "delegated",
          }),
        );
        await desktop.closeViewer();
        await desktop.quit();
        expect(await runIdentity(site)).toBe(host.identity.id);
      } finally {
        await desktop.quit();
        await host.close();
      }
    } finally {
      await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  },
  120000,
);

function handed(rows: v.InferOutput<typeof HistoryPageSchema>["rows"], id: TodoRequestId) {
  return rows.some(
    (r) =>
      r.objectType === "todoRequest" &&
      r.value.id === id &&
      r.value.state.kind === "answered" &&
      (r.value.state.arrival.kind === "handed" || r.value.state.arrival.kind === "received"),
  );
}
type PhoneCondition = {
  message?: MessageId;
  open?: "question" | "approval";
  answered?: TodoRequestId;
  through?: string;
};
async function phoneHead(page: Page, condition: PhoneCondition = {}) {
  const raw = await within(
    page.evaluate(
      async ({ path, condition }) => {
        const t = (await import(path)).pageThread;
        function read() {
          const status = t.status;
          if (
            !t.current ||
            !status.acknowledged ||
            status.installed.through !== status.acknowledged.through
          )
            return;
          const cache: ThreadCache = t.cache;
          const rows = Object.values(cache.rows).flatMap((r) => (r.row ? [r.row] : []));
          if (condition.through && status.acknowledged.through !== condition.through) return;
          if (
            condition.message &&
            !rows.some((r) => r.objectType === "message" && r.value.id === condition.message)
          )
            return;
          if (
            condition.open &&
            !rows.some(
              (r) =>
                r.objectType === "todoRequest" &&
                r.value.body.kind === condition.open &&
                r.value.state.kind === "open",
            )
          )
            return;
          if (
            condition.answered &&
            !rows.some(
              (r) =>
                r.objectType === "todoRequest" &&
                r.value.id === condition.answered &&
                r.value.state.kind === "answered",
            )
          )
            return;
          return {
            rows,
            head: status.acknowledged,
            permissions: status.permissions,
            connectionId: status.session.connectionId,
          };
        }
        if (read()) return read();
        return new Promise((resolve) => {
          const off = t.subscribe(() => {
            const value = read();
            if (value) {
              off();
              resolve(value);
            }
          });
        });
      },
      { path: modulePath, condition },
    ),
    20000,
    "acknowledged phone thread",
  );
  return v.parse(
    v.object({
      rows: HistoryPageSchema.entries.rows,
      head: SyncCursorSchema,
      permissions: v.array(v.string()),
      connectionId: v.string(),
    }),
    raw,
  );
}
describe.skipIf(!routed)("routed installed desktop handoff", () => {
  let dir: string,
    f: Awaited<ReturnType<typeof setup>>,
    desktop: Awaited<ReturnType<typeof launchInstalledDesktop>> | undefined;
  let cli: ReturnType<typeof installedFollow>,
    route: Awaited<ReturnType<typeof handoffRoute>>,
    remote: Awaited<ReturnType<typeof routedBrowser>>;
  let browser: Awaited<ReturnType<typeof remote.launch>>, phone: Page, phoneDevice: DeviceId;
  const desktopMethods: string[] = [];
  let message: MessageId, question: TodoReplyRecord, approval: TodoReplyRecord;
  let missedFrom: SyncPosition, firstEpoch: string, cliSub: SubscriptionId;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "kraka-handoff-"));
    f = await setup(dir, true);
    desktop = f.desktop;
    firstEpoch = desktop.first.connectionId;
    cli = installedFollow(f.site, f.args.threadId);
    cliSub = (await cli.at(() => true)).subscriptionId;
    route = await handoffRoute(new URL(f.host.publication.endpoint.replace(/^ws/, "http")).origin);
    remote = await routedBrowser(join(dir, "mobile"));
    browser = await remote.launch();
    await mobile("/routed");
    expect(JSON.parse(await mobile("/route"))[0].gateway).toBe("10.78.42.2");
    phone = await browser.context.newPage();
    await phone.goto(handoffOrigin);
  }, 120000);
  afterAll(async () => {
    try {
      await browser?.close();
      await remote?.close();
      await route?.close();
      await cli?.close();
      await desktop?.quit();
    } finally {
      try {
        await f?.host.close();
      } finally {
        if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      }
    }
  }, 30000);
  test("handoff 1. private route pairs a distinct phone and opens the original E/T", async () => {
    await pin(phone, f.host.identity);
    await phone.getByLabel("Project ID").fill(f.host.projectId);
    await phone.getByLabel("Invite ID").fill(f.host.inviteId);
    for (const right of DEFAULT_DEVICE_PERMISSIONS)
      await phone.getByLabel(right, { exact: true }).check();
    await phone.getByRole("button", { name: "Request pairing" }).click();
    await phone.locator("#application").waitFor();
    const pending = v.parse(
      PairingPendingSchema,
      await phone.evaluate(async (path) => (await import(path)).pagePairing, modulePath),
    );
    expect(await f.host.nextHostRecord(PairingPendingSchema)).toEqual(pending);
    phoneDevice = pending.deviceId;
    await approve(f.host.owner, pending);
    const completion = await f.host.nextHostRecord(PairingCompletedSchema);
    expect(completion.requestId).toBe(pending.requestId);
    expect(completion.permissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
    const session = await phase(phone, "sendable");
    if (session.phase !== "sendable") throw Error("Phone not configured");
    expect(session.configuration.environment.id).toBe(f.args.environmentId);
    const observed = await phone.evaluate(
      async ({ id, path }) => {
        const m = await import(path);
        return (
          await m
            .createBrowserCredentials({
              origin: Reflect.get(globalThis, "location").origin,
              environmentId: id,
            })
            .discover(id)
        ).registration.permissions;
      },
      { id: f.args.environmentId, path: modulePath },
    );
    expect(observed).toEqual(completion.permissions);
    await phone.getByLabel("Thread ID").fill(f.args.threadId);
    await phone.getByRole("button", { name: "Open thread" }).click();
    await phone.getByLabel("Message", { exact: true }).waitFor();
    const head = await phoneHead(phone);
    expect(head.head.scope).toEqual({ kind: "thread", threadId: f.args.threadId });
    expect(head.permissions).toEqual(expect.arrayContaining(["owner.decide", "thread.reply"]));
    expect(
      new Set([phoneDevice, f.desktop.deviceId, (await cli.at(() => true)).deviceId]).size,
    ).toBe(3);
    expect(f.host.events.items.filter((e) => e.event === "interrupt-received")).toHaveLength(0);
  }, 45000);
  test("handoff 2. cached history and one frozen phone send survive a lost receipt", async () => {
    const before = await phoneHead(phone);
    await phone.evaluate(async (path) => (await import(path)).pageThread.disconnect(), modulePath);
    const cached = await phone.evaluate(
      async (path) =>
        Object.values(((await import(path)).pageThread.cache as ThreadCache).scopes).map(
          (s) => s.cursor.through,
        ),
      modulePath,
    );
    expect(cached).toContain(before.head.through);
    expect(f.host.events.items.filter((e) => e.event === "turn")).toHaveLength(1);
    await phone.getByLabel("Message", { exact: true }).fill("question");
    await phone.getByRole("button", { name: "Send", exact: true }).click();
    await phone.getByRole("status").filter({ hasText: "Queued on this device" }).waitFor();
    const frozen = await phone.evaluate(
      async (path) => (await (await import(path)).pageThread.inspect()).queue.items[0].commandId,
      modulePath,
    );
    f.host.control(f.host.turn, "finish");
    await f.host.event("root-ended");
    await phone.evaluate(async (path) => (await import(path)).pageThread.connect(), modulePath);
    const lost = await route.inputs.until((r) => r.kind === "dropped");
    expect(lost.commandId).toBe(frozen);
    message = v.parse(MessageIdSchema, lost.messageId);
    await phone.evaluate(async (path) => (await import(path)).pageThread.connect(), modulePath);
    const reply = await route.inputs.until(
      (r) => r.kind === "receipt" && r.commandId === frozen,
      0,
      20000,
    );
    expect(reply.messageId).toBe(message);
    expect(reply.epoch).not.toBe(lost.epoch);
    const contains = (r: InstalledThread) =>
      r.rows.some((x) => x.objectType === "message" && x.value.id === message);
    await Promise.all([phoneHead(phone, { message }), cli.at(contains), f.desktop.at(contains)]);
    await phone.getByRole("status").filter({ hasText: "Delivered to thread" }).waitFor();
    expect(
      await phone.evaluate(
        async ({ id, path }) =>
          (await (await import(path)).pageThread.inspect()).receipts.bindings[id],
        { id: frozen, path: modulePath },
      ),
    ).toBe(message);
    await f.host.events.untilDispatch((e) => e.event === "turn" && e.text === "question");
  }, 60000);
  test("handoff 3. CLI stays subscribed through the answer and approval", async () => {
    const turn = await f.host.events.until((e) => e.event === "turn" && e.text === "question");
    const submitted = async (kind: "question" | "approval") => {
      f.host.control(turn, kind === "question" ? "callback" : "handoff-approval");
      const head = await phoneHead(phone, { open: kind });
      const row = head.rows.find(
        (r) =>
          r.objectType === "todoRequest" &&
          r.value.body.kind === kind &&
          r.value.state.kind === "open",
      );
      if (row?.objectType !== "todoRequest") throw Error("Open native request missing");
      const id = row.value.id;
      const receipt = await phone.evaluate(
        async ({ path, id, threadId, kind }) => {
          const t = (await import(path)).pageThread;
          return kind === "question"
            ? t.answer({
                threadId,
                todoRequestId: id,
                answers: [{ questionKey: "color", answer: "blue" }],
              })
            : t.decide({
                threadId,
                todoRequestId: id,
                decision: {
                  kind: "approval",
                  choiceKey: "accept",
                  decision: "allow",
                  scope: "once",
                },
              });
        },
        { path: modulePath, threadId: f.args.threadId, id, kind },
      );
      expect(receipt).toMatchObject({
        kind: "accepted",
        result: { kind: "todoAnswerStored", todoRequestId: id },
      });
      await phoneHead(phone, { answered: id });
      const r = await phone.evaluate(
        async ({ path, id }) => (await import(path)).pageThread.readAnswer(id),
        { id, path: modulePath },
      );
      const answer = v.parse(TodoReplyRecordSchema, r.result);
      expect(answer.deviceId).toBe(phoneDevice);
      expect(answer.at).toBeGreaterThan(0);
      expect(
        (await cli.at((r) => r.answers.some((a) => a.todoRequestId === id))).answers,
      ).toContainEqual(answer);
      return answer;
    };
    question = await submitted("question");
    expect(question.content).toEqual({
      kind: "question",
      answers: [{ questionKey: "color", answer: "blue" }],
    });
    const last = await f.desktop.at(
      (r) =>
        r.answers.some((a) => a.todoRequestId === question.todoRequestId) &&
        handed(r.rows, question.todoRequestId),
    );
    expect(last.answers).toContainEqual(question);
    desktopMethods.push(...(await f.desktop.methods()));
    await f.desktop.closeViewer();
    await f.desktop.quit();
    missedFrom = (f.desktop.records.items.at(-1) ?? last).head.through;
    desktop = undefined;
    approval = await submitted("approval");
    expect(approval.todoRequestId).not.toBe(question.todoRequestId);
    expect(approval.content).toMatchObject({ kind: "approval", choiceKey: "accept" });
    await f.host.events.until((e) => e.event === "reply-written" && e.id === 4002);
  }, 60000);
  test("handoff 4. desktop reseals the missed approval with the original phone author", async () => {
    desktop = await launchInstalledDesktop(f.args);
    expect(desktop.first.after?.through).toBe(missedFrom);
    expect(desktop.first.connectionId).not.toBe(firstEpoch);
    expect(desktop.deviceId).toBe(f.registered.deviceId);
    const check = (r: InstalledThread) =>
      r.answers.some((a) => a.todoRequestId === approval.todoRequestId) &&
      handed(r.rows, approval.todoRequestId);
    const reader = await desktop.at(check);
    const head = reader.head.through;
    const [terminal, p] = await Promise.all([
      cli.at((r) => r.head.through === head && check(r)),
      phoneHead(phone, { through: head }),
    ]);
    for (const r of [reader, terminal]) {
      expect(r.answers).toContainEqual(question);
      expect(r.answers).toContainEqual(approval);
      expect(r.rows.filter((x) => x.objectType === "message" && x.value.id === message)).toEqual(
        p.rows.filter((x) => x.objectType === "message" && x.value.id === message),
      );
      expect(r.rows.some((x) => x.objectType === "message" && x.value.id === message)).toBe(true);
    }
    expect(new Set(cli.records.items.map((r) => r.subscriptionId))).toEqual(new Set([cliSub]));
    expect(new Set(cli.records.items.map((r) => r.connectionId)).size).toBe(1);
    expect(p.head.environmentId).toBe(reader.environmentId);
    expect(reader.head.scope).toEqual(p.head.scope);
    desktopMethods.push(...(await desktop.methods()));
    expect(desktopMethods.filter((m) => m === "subscription.openThread")).toHaveLength(2);
    const phoneCommands = desktopMethods.filter((m) =>
      ["input.send", "todo.answer", "todo.decide", "round.stop"].includes(m),
    );
    expect(phoneCommands).toEqual([]);
    const turns = f.host.events.items.filter((e) => e.event === "turn" && e.text === "question");
    const replies = f.host.events.items.filter((e) => e.event === "reply-written");
    expect(turns).toHaveLength(1);
    expect(replies.map((e) => e.id)).toEqual([4001, 4002]);
    expect(replies[0]?.result).toMatchObject({ answers: { color: { answers: ["blue"] } } });
    expect(replies[1]?.result).toEqual({ decision: "accept" });
    const stops = f.host.events.items.filter((e) => e.event === "interrupt-received").length;
    expect(stops).toBe(0);
    console.info(
      JSON.stringify({
        installed: head,
        desktop: reader.connectionId,
        cli: terminal.connectionId,
        phone: p.connectionId,
        desktopSubmissions: phoneCommands.length,
        ordinary: turns.length,
        question: 1,
        approval: 1,
        stops,
      }),
    );
  }, 45000);
});
