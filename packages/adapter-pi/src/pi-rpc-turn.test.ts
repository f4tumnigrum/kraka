import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  NativeRequestIdSchema,
  NativeSessionIdSchema,
  NativeItemIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  QueuePositionSchema,
  RoundIdSchema,
  ThreadSchema,
  MessageIdSchema,
} from "@kraka/protocol";
import {
  firstPending,
  promoteSessionObservation,
  recordAdapterActivity,
  transitionRound,
  type AdapterCommand,
  type AdapterEventEnvelope,
} from "@kraka/environment";
import { ThreadJournal } from "../../environment/src/thread-journal";
import { buildPiPeer, piFixture } from "../../../tools/fixtures/pi-rpc";
import { probePi } from "./discovery";

let dir: string, exe: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-rpc-peer-"));
  exe = await buildPiPeer(dir);
}, 60_000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});
type Fixture = Awaited<ReturnType<typeof piFixture>>;
type Opened = Awaited<ReturnType<Fixture["open"]>>;
async function next(opened: Opened) {
  const ev = await opened.events.next();
  if (ev.done) throw Error("Pi stream ended early");
  return ev.value;
}
function reply(id: string): Extract<AdapterCommand, { kind: "deliverAnswer" }> {
  const attemptId = v.parse(AttemptIdSchema, crypto.randomUUID()),
    deliveryId = v.parse(DeliveryIdSchema, crypto.randomUUID());
  return {
    kind: "deliverAnswer",
    capability: "answerApprovalChoices",
    requestId: v.parse(NativeRequestIdSchema, id),
    attemptId,
    deliveryId,
    answer: {
      attemptId,
      deliveryId,
      authorId: v.parse(PrincipalIdSchema, "owner"),
      at: 3,
      content: { kind: "message", messageId: v.parse(MessageIdSchema, "reply") },
    },
    reply: { kind: "question", answers: [{ questionKey: id, answer: "jade" }] },
  };
}
const ticket = {
  attemptId: v.parse(AttemptIdSchema, "attempt"),
  deliveryId: v.parse(DeliveryIdSchema, "delivery"),
};
test("An extension can handle input without a model round", async () => {
  const f = await piFixture(exe);
  try {
    const h = await f.open();
    expect(await h.prompt("handled")).toEqual({
      kind: "ok",
      value: { kind: "service", result: { disposition: "handled" } },
    });
    const second = v.parse(AttemptIdSchema, "second");
    await h.prompt("retry", second);
    expect((await next(h)).payload).toMatchObject({ kind: "roundStarted", attemptId: second });
    expect((await next(h)).payload).toMatchObject({ kind: "roundEnded", attemptId: second });
    await f.adapter.close(h.session, "finished");
    expect((await h.events.next()).done).toBe(true);
    const changed = transitionRound(
      { ...ticket, phase: { kind: "handed", wroteAt: 1 } },
      { ...ticket, kind: "handled", at: 2 },
    );
    expect(changed).toEqual({ kind: "ok", value: { kind: "handled", handledAt: 2 } });
    if (changed.kind !== "ok") throw Error("Missing service disposition");
    const row = {
      id: v.parse(RoundIdSchema, "round"),
      place: v.parse(QueuePositionSchema, "1"),
      messageId: v.parse(MessageIdSchema, "message"),
      attempt: { ...ticket, phase: changed.value },
      source: "person" as const,
      previous: [],
    };
    expect(firstPending([row])).toBeUndefined();
  } finally {
    await f.close();
  }
}, 30_000);
test("A retry cannot create a second root", async () => {
  const f = await piFixture(exe);
  try {
    const h = await f.open();
    await h.prompt("retry");
    const start = await next(h),
      end = await next(h);
    expect(start.payload).toMatchObject({
      kind: "roundStarted",
      nativeRootTurnId: `weak:pi:1:${h.attemptId}`,
    });
    expect(end.payload).toMatchObject({
      kind: "roundEnded",
      nativeRootTurnId: `weak:pi:1:${h.attemptId}`,
      outcome: { reason: "completed", nativeReason: "stop" },
    });
    if (end.payload.kind !== "roundEnded") throw Error("Missing settlement");
    expect(end.payload.endTimeEvidence).toEqual({
      source: "environmentObserved",
      environmentObservedAt: end.payload.endedAt,
      executorEndedAt: null,
    });
    await f.adapter.close(h.session, "finished");
    expect((await h.events.next()).done).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);
test("A dead callback cannot answer a new process", async () => {
  const f = await piFixture(exe);
  try {
    const old = await f.open();
    await old.prompt("questions");
    await next(old);
    expect((await next(old)).payload).toMatchObject({
      kind: "requestOpened",
      requestId: "question-1",
    });
    const permit = f.permit("answerApprovalChoices");
    expect((await f.adapter.invoke(old.session, permit, reply("question-1"))).kind).toBe("ok");
    expect((await next(old)).payload).toMatchObject({
      kind: "requestOpened",
      requestId: "question-2",
    });
    const cached = reply("question-2");
    old.session.handle.process.rpc.child.kill("SIGKILL");
    const status = await old.session.handle.process.rpc.exited;
    const loss = await next(old);
    expect(loss.payload).toMatchObject({
      kind: "sessionLost",
      failure: { kind: "unexpectedExit", ...status },
    });
    const fresh = await f.open(old.session.nativeSessionId);
    expect(fresh.session.epoch).toBeGreaterThan(old.session.epoch);
    await fresh.prompt("questions");
    await next(fresh);
    await next(fresh);
    expect((await f.adapter.invoke(fresh.session, permit, reply("question-1"))).kind).toBe("ok");
    expect((await next(fresh)).payload).toMatchObject({
      kind: "requestOpened",
      requestId: "question-2",
    });
    expect(await f.adapter.invoke(old.session, permit, cached)).toMatchObject({
      kind: "rejected",
      reason: "requestExpired",
    });
    await f.adapter.close(fresh.session, "finished");
    const native = (await f.rows()).flatMap((row) =>
      row.event === "frameRead" &&
      typeof row.frame === "object" &&
      row.frame !== null &&
      "type" in row.frame &&
      row.frame.type === "extension_ui_response"
        ? [{ epoch: row.epoch, frame: row.frame }]
        : [],
    );
    expect(native).toEqual(
      [1, 2].map((epoch) => ({
        epoch,
        frame: { type: "extension_ui_response", id: "question-1", value: "jade" },
      })),
    );
  } finally {
    await f.close();
  }
}, 30_000);
test("Promotion preserves the observed timeline item", async () => {
  const f = await piFixture(exe, "beforeHistoryLink"),
    db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE threads(id TEXT PRIMARY KEY,data TEXT);CREATE TABLE messages(data TEXT);CREATE TABLE rounds(data TEXT)",
    );
    const env = v.parse(EnvironmentIdSchema, "environment"),
      journal = ThreadJournal.open(db, env);
    const thread = v.parse(ThreadSchema, {
      id: "pi-thread",
      projectId: "project",
      worktreeId: null,
      title: "Pi",
      lineage: { kind: "root" },
      version: "1",
    });
    db.transaction(() => journal.record([{ objectType: "thread", value: thread }]))();
    const h = await f.open(),
      binding = { ...h.session, threadId: thread.id, attemptId: h.attemptId },
      round = v.parse(RoundIdSchema, "round");
    const record = (ev: AdapterEventEnvelope) =>
      recordAdapterActivity(journal, binding, round, ev, null);
    const rows = () =>
      journal
        .read(
          {
            threadId: thread.id,
            environmentId: env,
            canRead: () => true,
            timelineItems: true,
            protocolMinor: 2,
          },
          "owner",
        )
        .rows.flatMap((r) =>
          r.row.objectType === "timelineItem" && r.row.value.kind === "executorObservation"
            ? [r.row.value]
            : [],
        );
    await h.prompt("observe");
    expect((await next(h)).payload.kind).toBe("roundStarted");
    const event = await next(h);
    record(event);
    const [original] = rows();
    if (!original) throw Error("Missing persisted observation");
    expect(original.assignment).toEqual({ kind: "session" });
    expect(original.version).toBe(v.parse(ObjectVersionSchema, "1"));
    f.release();
    const proof = await next(h);
    record(proof);
    record(proof);
    if (proof.payload.kind !== "sessionObservationLinked") throw Error("Expected history evidence");
    const link = {
      kind: "attempt" as const,
      source: original.source,
      attemptId: h.attemptId,
      relationship: proof.payload.relationship,
    };
    const promoted = {
      ...original,
      version: v.parse(ObjectVersionSchema, "2"),
      assignment: {
        kind: "attempt",
        attemptId: h.attemptId,
        relationship: {
          kind: "item",
          nativeItemId: v.parse(NativeItemIdSchema, "assistant-native-8"),
        },
      },
    } as const;
    expect(rows()).toEqual([promoted]);
    for (const change of [
      { instanceId: v.parse(ExecutorInstanceIdSchema, "other") },
      { nativeSessionId: v.parse(NativeSessionIdSchema, "other") },
      { epoch: 99 },
      { eventId: "other" },
      { sourceId: "other" },
    ]) {
      expect(
        promoteSessionObservation(original, { ...link, source: { ...original.source, ...change } }),
      ).toEqual({ kind: "rejected", reason: "wrongAttempt" });
    }
    const linkedPayload = proof.payload;
    const competing = v.parse(AttemptIdSchema, "foreign");
    expect(
      recordAdapterActivity(
        journal,
        { ...binding, attemptId: competing },
        round,
        { ...proof, payload: { ...linkedPayload, attemptId: competing } },
        null,
      ),
    ).toBe("idConflict");
    expect(rows()).toEqual([promoted]);
    await f.adapter.close(h.session, "restart");
    const reopened = await f.open(h.session.nativeSessionId);
    expect(() =>
      recordAdapterActivity(
        journal,
        { ...reopened.session, attemptId: reopened.attemptId, threadId: thread.id },
        round,
        proof,
        null,
      ),
    ).toThrow("Foreign");
    expect(rows()).toEqual([promoted]);
  } finally {
    db.close(true);
    await f.close();
  }
}, 30_000);
test("Pi reports pipe loss while the child still lives", async () => {
  const f = await piFixture(exe, "beforePipeClose");
  try {
    const h = await f.open();
    await h.prompt("pipe");
    expect((await next(h)).payload.kind).toBe("roundStarted");
    expect((await next(h)).payload.kind).toBe("requestOpened");
    f.release();
    const loss = await next(h);
    expect(loss.payload).toMatchObject({
      kind: "sessionLost",
      failure: { kind: "transportError" },
    });
    expect(h.session.handle.process.rpc.child.exitCode).toBeNull();
    await f.adapter.close(h.session, "shutdown");
    expect((await h.events.next()).done).toBe(true);
  } finally {
    await f.close();
  }
}, 30_000);
test("A native read error expires the pending question", async () => {
  const f = await piFixture(exe);
  try {
    const h = await f.open();
    await h.prompt("questions");
    await next(h);
    const request = (await next(h)).payload;
    if (request.kind !== "requestOpened") throw Error("Expected a live Pi question");
    const { handle } = h.session;
    expect(handle.hasCallback(request.requestId)).toBe(true);
    handle.process.rpc.child.stdout.destroy(
      Object.assign(Error("pipe disconnected"), { code: "ERROR_NO_DATA" }),
    );
    expect((await next(h)).payload).toMatchObject({
      kind: "sessionLost",
      failure: { kind: "transportError" },
    });
    expect(handle.hasCallback(request.requestId)).toBe(false);
    expect(handle.process.rpc.child.exitCode).toBeNull();
  } finally {
    await f.close();
  }
}, 30_000);
test("A queued prompt waits for native pickup", async () => {
  const f = await piFixture(exe, "queued");
  try {
    const h = await f.open();
    await h.prompt("queued");
    await f.wait("queued", 1);
    expect((await f.rows()).some((r) => r.event === "agentStarted")).toBe(false);
    f.release();
    expect((await next(h)).payload.kind).toBe("roundStarted");
    expect((await next(h)).payload.kind).toBe("roundEnded");
  } finally {
    await f.close();
  }
}, 30_000);
test("Probes and tool approval use the configured Pi process", async () => {
  const f = await piFixture(exe);
  try {
    expect(f.probe).toMatchObject({
      binaryVersion: "1.6.0",
      compatibilityAdvisory: null,
      declaration: {
        readiness: { authenticated: { state: "yes", verifiedAt: expect.any(Number) } },
        permission: { modes: ["ask", "edits"], enforcement: "adapter" },
      },
    });
    const h = await f.open();
    await h.prompt("policy");
    await next(h);
    const approval = await next(h);
    expect(approval.payload).toMatchObject({
      kind: "requestOpened",
      body: { kind: "approval", tool: "command" },
    });
    const cmd = reply("approval");
    cmd.reply = { kind: "approval", decision: "deny", choiceKey: "deny", scope: "once" };
    expect((await f.adapter.invoke(h.session, f.permit("answerApprovalChoices"), cmd)).kind).toBe(
      "ok",
    );
    await next(h);
    const rows = await f.rows();
    expect(rows).toContainEqual(expect.objectContaining({ event: "toolDecision", blocked: true }));
    expect(
      rows
        .filter((r) => r.event === "launch")
        .every((r) => r.account === f.launch.accountDirectory && r.cwd === f.launch.cwd),
    ).toBe(true);
    expect(
      (await probePi({ ...f.launch, executable: join(dir, "missing") }, f.permission)).declaration
        .readiness.installed,
    ).toMatchObject({ state: "no", verifiedAt: expect.any(Number) });
    expect(
      (
        await probePi(
          { ...f.launch, env: { ...f.launch.env, KRAKA_PI_MISSING_BRIDGE: "1" } },
          f.permission,
        )
      ).declaration.readiness.operation.state,
    ).toBe("no");
  } finally {
    await f.close();
  }
}, 30_000);
