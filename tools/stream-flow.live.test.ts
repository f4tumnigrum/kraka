import { expect, test } from "bun:test";
import { join } from "node:path";
import * as v from "valibot";
import { EnvironmentRpcUnavailableError } from "../packages/client-runtime/src/subscription-session";
import type { SubscriptionWriter } from "../packages/daemon/src/subscription-writer";
import {
  SyncCursorSchema,
  SubscriptionPageSchema,
  TodoRequestSchema,
  RequestResultSchema,
  type SignedRequest,
  type SyncCursor,
} from "@kraka/protocol";
import { begin, flowFixture, Gate, slow, type Remote } from "./fixtures/flow-socket";
import { parseScenario } from "./fixtures/scenario";
import { fixtureSession } from "./fixtures/flow-session";
import { SubscriptionSession } from "../packages/client-runtime/src/subscription-session";
import { utf8 } from "../packages/daemon/src/flow-socket";
import { entry, terminate, within, withState } from "./fixtures/replay-process";
import { transfer } from "./stream-flow-bench";

const root = join(import.meta.dir, "..");
test("the business client distinguishes expired, unknown and revoked keys", () => {
  const f = fixtureSession("desktop", "handshake");
  for (const reason of ["keyExpired", "unknownKey", "revokedKey"] as const) {
    const c = new SubscriptionSession(
      f.hello,
      f.authorized,
      { utf8, now: () => 0, write: () => 1 },
      () => {},
    );
    c.peer.input(
      JSON.stringify({
        lane: "control",
        epoch: f.hello.connectionId,
        streamId: 0,
        offsetBytes: 0,
        message: { kind: "session.rejected", reason },
      }),
    );
    expect(c.failure).toBe(reason);
    expect(c.snapshot(1).environment).toBe("unavailable");
  }
});
const question = parseScenario(
  await Bun.file(join(root, "fixtures/scenarios/first-answer-wins.json")).json(),
);
function cursor(thread: string, position: string): SyncCursor {
  return v.parse(SyncCursorSchema, {
    environmentId: "studio",
    databaseGeneration: "database-main",
    visibilityGeneration: "owner-scope",
    scope: { kind: "thread", threadId: thread },
    shapeVersion: 1,
    through: position,
  });
}
function offer(
  w: SubscriptionWriter,
  base: SyncCursor,
  head: SyncCursor,
  changes: unknown[],
  count = 1,
) {
  const b = begin(w.subscriptionId, base, head);
  const pages = Array.from({ length: count }, (_, pageNumber) =>
    v.parse(SubscriptionPageSchema, {
      kind: "subscription.page",
      subscriptionId: w.subscriptionId,
      passId: b.passId,
      through: head,
      pageNumber,
      pageCount: count,
      changes,
    }),
  );
  if (!w.offer({ begin: b, pages })) w.end("backlogExceeded");
}
const atP = cursor("thread-notes", "1");
function seed(w: SubscriptionWriter, epoch: string, onPage = () => {}) {
  const b = begin(w.subscriptionId, atP, atP);
  function* pages() {
    for (let pageNumber = 0; pageNumber < 4; pageNumber++) {
      onPage();
      const value = {
        id: `seed-${pageNumber}`,
        threadId: "thread-notes",
        roundId: null,
        author: { kind: "person", id: "person-lee" },
        text: "",
        references: [],
        attachments: [],
        version: "1",
      };
      const raw = {
        kind: "subscription.page",
        subscriptionId: w.subscriptionId,
        passId: b.passId,
        through: atP,
        pageNumber,
        pageCount: 4,
        changes: [{ kind: "object.replace", object: { objectType: "message", value } }],
      };
      const frame = {
        lane: "data",
        epoch,
        streamId: w.id,
        offsetBytes: pageNumber * 1024,
        message: raw,
      };
      value.text = "s".repeat(1024 - Buffer.byteLength(JSON.stringify(frame)));
      yield v.parse(SubscriptionPageSchema, raw);
    }
  }
  expect(w.offer({ begin: b, pages: pages() })).toBe(true);
}
function writer(r: Remote, id: number) {
  const w = r.writers.get(id);
  if (!w) throw Error(`Missing writer ${id}`);
  return w;
}
const ready = (c: { client: { snapshot: (id: number) => { environment: string } } }) =>
  c.client.snapshot(1).environment === "ready";

test("1. the ordinary RPC waits for configuration and the thread waits for its seal", async () => {
  await flowFixture(async ({ connect }) => {
    const config = new Gate("session.configuration"),
      page = new Gate("subscription.page"),
      seal = new Gate("subscription.seal");
    const c = await connect("desktop", { gates: [config, page, seal], deferOpen: true });
    await config.armed();
    const command = c.session.request("access.listSessions", {});
    await expect(c.client.rpc(command)).rejects.toBeInstanceOf(EnvironmentRpcUnavailableError);
    expect(c.dispatches()).toBe(0);
    config.release(c.remote);
    await c.wait(() => ready(c), "configuration");
    const opening = c.open(1);
    await c.wait(() => !!c.openRequests[0], "open dispatch");
    const req = c.openRequests[0];
    if (req?.method !== "subscription.openThread") throw Error("Missing open");
    const w = writer(c.remote, 1),
      head = cursor("thread-notes", "2");
    offer(w, atP, head, []);
    await page.armed();
    expect(c.client.snapshot(1)).toMatchObject({
      environment: "ready",
      thread: "synchronizing",
      installed: atP,
      pages: [],
    });
    page.release(c.remote);
    await seal.armed();
    expect(c.client.snapshot(1).pages).toEqual([]);
    seal.release(c.remote);
    c.remote.respond(req, {
      kind: "subscriptionOpened",
      streamId: 1,
      subscriptionId: w.subscriptionId,
    });
    await opening;
    await c.wait(() => c.client.snapshot(1).thread === "live", "sealed open receipt");
    expect(c.client.snapshot(1).installed).toEqual(head);
    expect(await c.client.rpc(command)).toMatchObject({
      kind: "accepted",
      commandId: command.commandId,
    });
  });
});

test("2. reconnect exposes the phone answer at P and installs H only after its seal", async () => {
  const initial = question.environments[0]?.objects.find((o) => o.objectType === "todoRequest");
  if (initial?.objectType !== "todoRequest") throw Error("Missing question");
  let stored = initial.value,
    answerText = "";
  const head = cursor("thread-notes", "2");
  let cached = atP;
  await flowFixture(async ({ connect }) => {
    const desktop = await connect("desktop");
    await desktop.wait(() => ready(desktop), "ready");
    await desktop.open(1);
    desktop.close();
    const phone = await connect("tablet", {
      dispatch(r, remote) {
        if (r.method !== "todo.answer" || stored.state.kind !== "open")
          throw Error("Expected open question");
        const a = r.payload.answers[0];
        answerText = a.answer;
        stored = v.parse(TodoRequestSchema, {
          ...stored,
          version: head.through,
          state: {
            kind: "answered",
            route: stored.state.route,
            answer: {
              authorId: "person-lee",
              deviceId: "tablet",
              at: 1000,
              attemptId: "answer",
              deliveryId: "delivery",
              content: { kind: "message", messageId: "answer-message" },
            },
            arrival: { kind: "recorded" },
            previousAttempts: [],
          },
        });
        remote.respond(r, { kind: "todoAnswerStored", todoRequestId: r.payload.todoRequestId });
      },
    });
    await phone.wait(() => ready(phone), "phone ready");
    const action = question.inputs.find(
      (i) => i.event.kind === "commands" && i.event.deviceId === "tablet",
    )?.event;
    if (action?.kind !== "commands" || !action.requests[0]) throw Error("Missing phone command");
    expect(await phone.client.rpc(action.requests[0])).toMatchObject({
      kind: "accepted",
      result: { kind: "todoAnswerStored" },
    });
    const seal = new Gate("subscription.seal");
    const back = await connect("desktop", {
      epoch: "desktop-second",
      gates: [seal],
      installed: (_, h) => {
        cached = h;
      },
    });
    await back.wait(() => ready(back), "reconnect");
    await back.open(1, cached);
    offer(writer(back.remote, 1), cached, head, [
      { kind: "object.replace", object: { objectType: "todoRequest", value: stored } },
      {
        kind: "object.replace",
        object: {
          objectType: "message",
          value: {
            id: "answer-message",
            threadId: stored.threadId,
            roundId: stored.roundId,
            author: { kind: "person", id: "person-lee" },
            text: answerText,
            references: [],
            attachments: [],
            version: "2",
          },
        },
      },
    ]);
    await seal.armed();
    await back.wait(() => back.client.snapshot(1).pages.length === 1, "resolved page");
    const snapshot = back.client.snapshot(1);
    expect(snapshot).toMatchObject({
      environment: "ready",
      thread: "synchronizing",
      installed: atP,
    });
    expect(snapshot.pages[0]?.changes).toMatchObject([
      {
        object: {
          objectType: "todoRequest",
          value: {
            id: initial.value.id,
            state: {
              kind: "answered",
              route: { requestId: "native-title" },
              answer: { deviceId: "tablet", content: { messageId: "answer-message" } },
            },
          },
        },
      },
      { object: { objectType: "message", value: { id: "answer-message", text: "Harbor" } } },
    ]);
    expect(cached).toEqual(atP);
    seal.release(back.remote);
    await back.wait(() => back.client.snapshot(1).thread === "live", "matching seal");
    expect(cached).toEqual(head);
  });
});

function scheduleInput(r: SignedRequest, remote: Remote, subscribers: Remote[], version: number) {
  if (r.method !== "input.send") throw Error("Expected input");
  const notes = r.payload.threadId === "thread-notes",
    key = notes ? "outline" : "update";
  const streamId = notes ? 1 : 2,
    position = String(version);
  const ids = {
    messageId: `message-${key}`,
    roundId: `round-${key}`,
    attemptId: `attempt-round-${key}`,
    deliveryId: `delivery-round-${key}`,
  };
  remote.respond(r, v.parse(RequestResultSchema, { kind: "inputScheduled", ...ids }));
  const changes = [];
  const message = {
    id: ids.messageId,
    threadId: r.payload.threadId,
    roundId: ids.roundId,
    author: { kind: "person", id: "person-lee" },
    ...r.payload.content,
    version: position,
  };
  const round = {
    id: ids.roundId,
    threadId: r.payload.threadId,
    messageId: ids.messageId,
    place: "1",
    attempt: {
      attemptId: ids.attemptId,
      deliveryId: ids.deliveryId,
      phase: { kind: "filed", gate: "eligible" },
    },
    version: position,
  };
  for (const [objectType, value] of [
    ["message", message],
    ["round", round],
  ] as const)
    changes.push(
      { kind: "object.replace", object: { objectType, value } },
      { kind: "window.enter", key: { objectType, id: value.id } },
    );
  for (const subscriber of subscribers)
    offer(
      writer(subscriber, streamId),
      cursor(r.payload.threadId, "1"),
      cursor(r.payload.threadId, position),
      changes,
    );
}

test("3. the slow fixture releases exactly one window, or times out alone on a fresh connection", async () => {
  await flowFixture(async ({ connect }) => {
    const subscribers: Remote[] = [];
    let version = 1;
    const desktop = await connect("desktop", { holdCredit: 1 });
    const tablet = await connect("tablet", {
      dispatch: (r, remote) => scheduleInput(r, remote, subscribers, ++version),
    });
    subscribers.push(desktop.remote, tablet.remote);
    for (const c of [desktop, tablet]) {
      await c.wait(() => ready(c), "ready");
      await c.open(1);
      await c.open(2);
    }
    seed(writer(desktop.remote, 1), desktop.session.hello.connectionId);
    await desktop.wait(() => desktop.client.snapshot(1).thread === "live", "seed pass");
    expect(desktop.remote.peer.send.snapshot(1)).toMatchObject({
      producedBytes: 4096,
      sentBytes: 4096,
      consumedBytes: 0,
      reservedBytes: 0,
    });
    for (const c of [desktop, tablet]) c.messages.length = 0;
    for (const { label, event } of slow.inputs) {
      if (event.kind === "commands") {
        for (const r of event.requests)
          expect(await tablet.client.rpc(r)).toMatchObject({
            kind: "accepted",
            commandId: r.commandId,
          });
      } else if (event.kind === "window") {
        desktop.releaseCredit(event.update.streamId, event.update.consumedBytes);
        desktop.client.peer.control(event.update);
        desktop.client.peer.pump();
      } else throw Error("Unexpected fixture input");
      for (const [c, device] of [
        [desktop, "desktop"],
        [tablet, "tablet"],
      ] as const) {
        const expected =
          slow.clients.find((cl) => cl.deviceId === device)?.expected.find((e) => e.after === label)
            ?.messages ?? [];
        await c.wait(() => c.messages.length >= expected.length, `${label} ${device}`);
        expect<unknown>(c.messages.splice(0)).toEqual(expected);
      }
      if (event.kind === "commands")
        expect(desktop.remote.peer.send.snapshot(1)?.sentBytes).toBe(4096);
    }
    expect(desktop.remote.peer.send.snapshot(1)?.limitBytes).toBeGreaterThanOrEqual(8192);
    expect(desktop.client.snapshot(1)).toMatchObject({
      thread: "live",
      installed: cursor("thread-notes", "2"),
    });
    expect(
      await desktop.client.rpc(desktop.session.request("access.listSessions", {})),
    ).toMatchObject({ kind: "accepted" });
  });
  await flowFixture(async ({ connect }) => {
    const c = await connect("desktop", { holdCredit: 1 });
    await c.wait(() => ready(c), "ready");
    await c.open(1);
    await c.open(2);
    seed(writer(c.remote, 1), c.session.hello.connectionId);
    const start = performance.now();
    await c.wait(
      () => c.messages.some((m) => m.kind === "subscription.ended"),
      "acknowledgement timeout",
      20000,
    );
    expect(performance.now() - start).toBeGreaterThanOrEqual(14999);
    expect<unknown>(c.messages.filter((m) => m.kind === "subscription.ended")).toEqual([
      {
        kind: "subscription.ended",
        subscriptionId: "desktop-thread-notes",
        reason: "acknowledgementTimeout",
      },
    ]);
    expect(c.remote.peer.send.snapshot(1)).toBeUndefined();
    expect(c.remote.peer.send.snapshot(2)).toBeDefined();
    const req = c.session.request("access.listSessions", {});
    expect(await c.client.rpc(req)).toMatchObject({ kind: "accepted", commandId: req.commandId });
  });
}, 30000);

test("a full socket data queue protects the next source, control receipt and small subscription", async () => {
  await flowFixture(async ({ connect }) => {
    const c = await connect("desktop");
    await c.wait(() => ready(c), "ready");
    for (let id = 1; id <= 16; id++)
      await c.client.rpc(
        c.session.request("subscription.openThread", {
          streamId: id,
          subscriptionId: `budget-${id}`,
          threadId: "thread-notes",
          after: atP,
          recheckTodos: [],
          knownWindow: [],
        }),
      );
    const epoch = c.session.hello.connectionId;
    for (let id = 1; id <= 14; id++) {
      seed(writer(c.remote, id), epoch);
      c.remote.peer.pump(1);
      for (let n = 0; n < 4; n++) expect(c.remote.peer.send.reserve(id)).toBe(true);
    }
    let reads = 0;
    seed(writer(c.remote, 15), epoch, () => reads++);
    expect(c.remote.peer.send.pending.data).toBe(57344);
    expect(c.remote.peer.send.reserve(15)).toBe(false);
    expect(reads).toBe(0);
    const head = cursor("thread-notes", "2");
    offer(writer(c.remote, 16), atP, head, []);
    expect(await c.client.rpc(c.session.request("access.listSessions", {}))).toMatchObject({
      kind: "accepted",
    });
    await c.wait(() => c.client.snapshot(16).thread === "live", "small stream");
    expect(c.client.snapshot(16).installed).toEqual(head);
    await c.wait(() => c.client.snapshot(15).thread === "live", "next producer resumes");
    expect(reads).toBe(4);
  });
});

test("synthetic content traverses the real socket in both directions", async () => {
  for (const direction of ["upload", "download"] as const) {
    const trial = await transfer(root, direction, 1_000_000, "loopback");
    expect(trial.bytes).toBe(1_000_000);
    expect(trial.labels.length).toBe(trial.sent);
  }
});

test("foreground ready follows bind, invalid settings exit before publication", async () => {
  await withState(async (dir) => {
    const args = [
      process.execPath,
      join(root, entry),
      "daemon",
      "--state-dir",
      dir,
      "--listen",
      "127.0.0.1",
      "--port",
    ];
    const invalid = Bun.spawnSync([...args, "-1"]);
    expect(invalid.exitCode).toBe(1);
    expect(invalid.stdout.length).toBe(0);
    const child = Bun.spawn([...args, "0"], { stdout: "pipe", stderr: "pipe" });
    try {
      const line = await within(child.stdout.getReader().read(), 5000, "ready");
      const raw = new TextDecoder().decode(line.value);
      expect(raw.endsWith("\n")).toBe(true);
      const record = JSON.parse(raw);
      expect(record).toMatchObject({
        kind: "ready",
        host: "127.0.0.1",
        origin: `http://127.0.0.1:${record.port}`,
      });
      expect((await fetch(`${record.origin}/ws`)).status).toBe(403);
    } finally {
      await terminate(child);
    }
  });
});
