import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OrdinaryStops,
  openWriter,
  openStore,
  readRound,
  recordInputEvidence,
} from "@kraka/environment";
import {
  CommandIdSchema,
  HostInstanceIdSchema,
  PrincipalIdSchema,
  RoundSchema,
  ExecutorInstanceIdSchema,
  CaptureIdSchema,
} from "@kraka/protocol";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  TodoAnswerSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
} from "@kraka/protocol";
import { Callbacks, serverRequest, type AnswerDelivery } from "./requests";
import { notification } from "./native";
import { translateCodexFrame, type CodexTurnState } from "./translate";
const params = {
  threadId: "native",
  turnId: "root",
  itemId: "patch",
  availableDecisions: ["decline"],
};
function request(id: number | string = 4001) {
  const c = serverRequest("item/fileChange/requestApproval", params, id);
  if (!c) throw Error("Missing callback");
  return c;
}
const answer = v.parse(TodoAnswerSchema, {
  authorId: "owner",
  at: 1,
  attemptId: "answer-attempt",
  deliveryId: "answer-delivery",
  content: { kind: "message", messageId: "answer" },
});
function delivery(c: ReturnType<typeof request>, key = "decline"): AnswerDelivery {
  return {
    kind: "deliverAnswer",
    capability: "answerApprovalChoices",
    requestId: c.requestId,
    answer,
    deliveryId: answer.deliveryId,
    attemptId: answer.attemptId,
    reply: {
      kind: "approval",
      scope: "once",
      choiceKey: key,
      decision: key === "decline" ? "deny" : "allow",
    },
  };
}
test("a file rejection uses the offered file decision and original string RPC ID", async () => {
  const table = new Callbacks(),
    c = request("4001"),
    writes: unknown[] = [];
  table.open(c);
  const write = async (id: string | number, data: object) => {
    writes.push({ id, data });
  };
  expect((await table.replyToNative(delivery(c, "accept"), write)).kind).toBe("rejected");
  expect((await table.replyToNative(delivery(c), write)).kind).toBe("ok");
  expect((await table.replyToNative(delivery(c), write)).kind).toBe("rejected");
  expect(writes).toEqual([{ id: "4001", data: { decision: "decline" } }]);
});
test("a closed callback cannot answer a later request with the same number", async () => {
  const old = new Callbacks(),
    next = new Callbacks(),
    c = request(),
    writes: number[] = [];
  old.open(c);
  old.clear();
  expect(next.open(request())).toBe(true);
  const write = async () => {
    writes.push(1);
  };
  expect((await old.replyToNative(delivery(c), write)).kind).toBe("rejected");
  expect(writes).toEqual([]);
  expect(next.has(c.requestId)).toBe(true);
});
test("a successful root end wins a concurrent ordinary stop and retains its first time", () => {
  const state: CodexTurnState = {
    sessionId: v.parse(NativeSessionIdSchema, "native"),
    root: v.parse(NativeRootTurnIdSchema, "root"),
    attemptId: v.parse(AttemptIdSchema, "attempt"),
    deliveryId: v.parse(DeliveryIdSchema, "delivery"),
    received: false,
    startedAt: 100,
    ended: false,
    finals: new Set(),
    tools: new Set(),
    terminal: null,
  };
  function terminal(status: string, at: number) {
    const f = notification(
      "turn/completed",
      { threadId: "native", turn: { id: "root", status, completedAt: at } },
      [],
    );
    if (!f) throw Error("Missing terminal");
    return f;
  }
  const first = translateCodexFrame(terminal("completed", 12.345), state, 14000);
  expect(first.events).toMatchObject([
    {
      kind: "roundEnded",
      endedAt: 12345,
      outcome: { reason: "completed" },
      endTimeEvidence: {
        source: "executorReported",
        executorEndedAt: 12345,
        environmentObservedAt: 14000,
      },
    },
  ]);
  expect(translateCodexFrame(terminal("interrupted", 13), first.state, 15000).events).toEqual([]);
});
test("the 15-second deadline inspects only the original root, once; late replies retain both times after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kraka-stop-clock-"));
  const lock = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, "host"),
    performance.now() + 1000,
  );
  if (lock.kind !== "writer") throw Error("Expected writer");
  let store = openStore(lock.lease);
  let tick = 0,
    due = 0,
    checked = 0,
    sent = 0;
  let fire = () => {};
  const clock = {
    now: () => 100000 + tick,
    monotonic: () => tick,
    after: (ms: number, fn: () => void) => {
      due = tick + ms;
      fire = fn;
      return () => {};
    },
  };
  const stops = new OrdinaryStops(store, clock);
  try {
    const target = {
      family: "codex" as const,
      instanceId: v.parse(ExecutorInstanceIdSchema, "i"),
      epoch: 3,
      nativeSessionId: v.parse(NativeSessionIdSchema, "t"),
    };
    const root = {
      id: v.parse(NativeRootTurnIdSchema, "turn"),
      sessionId: target.nativeSessionId,
      beganAt: 100,
    };
    const r = v.parse(RoundSchema, {
      id: "r",
      threadId: "thread",
      messageId: "m",
      place: "1",
      version: "1",
      attempt: { attemptId: "a", deliveryId: "d", phase: { kind: "working", root, receipt: null } },
    });
    store.db.run("INSERT INTO rounds VALUES(?,?,'person')", [r.id, JSON.stringify(r)]);
    store.db.run("INSERT INTO deliveries VALUES(?,?,1,?)", [
      r.attempt.deliveryId,
      r.id,
      JSON.stringify({
        target,
        attemptId: r.attempt.attemptId,
        deliveryId: r.attempt.deliveryId,
        messageVersion: "1",
        input: { id: r.messageId, text: "1", references: [], attachments: [] },
      }),
    ]);
    const ack = Promise.withResolvers<boolean>();
    stops.endpoints.set(r.attempt.attemptId, {
      root: root.id,
      interrupt: async () => {
        sent++;
        return ack.promise;
      },
      inspect: async () => {
        checked++;
      },
    });
    const actor = {
      environmentId: lock.lease.environmentId,
      id: v.parse(PrincipalIdSchema, "device"),
      allows: () => true,
    };
    const ctx = { actor, transaction: store, commandId: v.parse(CommandIdSchema, "stop") };
    const stop = {
      method: "round.stop" as const,
      payload: { threadId: r.threadId, attemptId: r.attempt.attemptId },
      commandId: ctx.commandId,
    };
    const read = () =>
      stops.command(ctx, {
        method: "round.readStop",
        commandId: v.parse(CommandIdSchema, "read"),
        payload: { threadId: r.threadId, stopCommandId: ctx.commandId },
      });
    const receipt = stops.command(ctx, stop);
    expect(receipt.kind).toBe("accepted");
    expect(stops.command(ctx, stop)).toEqual(receipt);
    expect(sent).toBe(1);
    expect(due).toBe(15000);
    tick = 14999;
    fire();
    expect(checked).toBe(0);
    expect(due).toBe(15000);
    tick = 15000;
    fire();
    await Promise.resolve();
    expect(checked).toBe(1);
    expect(read()).toMatchObject({
      result: { disposition: "unconfirmed", timedOutAt: 115000, reachedAt: null },
    });
    expect(readRound(store.db, r.id)?.attempt.phase.kind).toBe("working");
    const first = {
      kind: "rootEnded" as const,
      ...r.attempt,
      root,
      outcome: "completed" as const,
      captureId: v.parse(CaptureIdSchema, "capture"),
      endedAt: 1234,
      endTimeEvidence: {
        source: "executorReported" as const,
        executorEndedAt: 1234,
        environmentObservedAt: 4567,
      },
    };
    expect(recordInputEvidence(store, target, first).kind).toBe("ok");
    stops.ended(r.attempt.attemptId);
    expect(
      recordInputEvidence(store, target, {
        ...first,
        endedAt: 2345,
        endTimeEvidence: { ...first.endTimeEvidence, executorEndedAt: 2345 },
      }).kind,
    ).toBe("ok");
    tick = 16000;
    ack.resolve(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(read()).toMatchObject({
      result: { disposition: "alreadyEnded", timedOutAt: 115000, reachedAt: 116000 },
    });
    stops.close();
    store.db.close(true);
    store = openStore(lock.lease);
    expect(readRound(store.db, r.id)?.attempt.phase).toMatchObject({
      kind: "closing",
      endedAt: 1234,
      endTimeEvidence: first.endTimeEvidence,
    });
    store.db.run(
      "UPDATE rounds SET data=json_remove(data,'$.attempt.phase.endTimeEvidence') WHERE id=?",
      [r.id],
    );
    expect(readRound(store.db, r.id)?.attempt.phase).toMatchObject({
      endedAt: 1234,
      endTimeEvidence: { source: "unknown", executorEndedAt: null, environmentObservedAt: null },
    });
  } finally {
    stops.close();
    store.db.close(true);
    lock.close();
    await rm(dir, { recursive: true, force: true });
  }
});
