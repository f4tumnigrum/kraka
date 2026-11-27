import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
} from "@kraka/protocol";
import { notification } from "./native";
import { readLines } from "./stdio";
import { type CodexTurnState, translateCodexFrame } from "./translate";
const sessionId = v.parse(NativeSessionIdSchema, "thread"),
  root = v.parse(NativeRootTurnIdSchema, "root");
function initial(): CodexTurnState {
  return {
    sessionId,
    root,
    attemptId: v.parse(AttemptIdSchema, "attempt"),
    deliveryId: v.parse(DeliveryIdSchema, "delivery"),
    startedAt: null,
    received: false,
    ended: false,
    finals: new Set(),
    tools: new Set(),
    terminal: null,
  };
}
function run(method: string, params: unknown, state = initial(), clock: number | null = null) {
  const frame = notification(method, params, []);
  if (!frame) throw new Error("Missing native frame");
  return translateCodexFrame(frame, state, clock);
}
const target = { threadId: sessionId, turnId: root };
const complete = (time: unknown, id: string = root, threadId: string = sessionId) => ({
  threadId,
  turn: { id, rootTurnId: id, status: "completed", completedAt: time },
});
test("a response alone cannot start a round; receipt needs this delivery and a native user item", () => {
  expect(notification("turn/start", { turn: { id: root } }, [])).toBeNull();
  const user = { type: "userMessage", id: "item", clientId: null };
  expect(run("item/started", { ...target, item: user }).events).toBeEmpty();
  const received = run("item/completed", { ...target, item: { ...user, clientId: "delivery" } });
  expect(received.events).toMatchObject([
    { kind: "deliveryReceived", deliveryId: "delivery", receipt: { sessionId, itemId: "item" } },
  ]);
  expect(
    run("item/completed", { ...target, item: { ...user, clientId: "delivery" } }, received.state)
      .events,
  ).toBeEmpty();
});
test("a repeated final replaces fragments exactly once, and a foreign root or thread cannot settle", () => {
  const final = { ...target, item: { type: "agentMessage", id: "msg", text: "a b" } };
  const first = run("item/completed", final);
  expect(first.events).toMatchObject([{ kind: "contentDelta", text: "", finalText: "a b" }]);
  expect(run("item/completed", final, first.state).events).toBeEmpty();
  expect(run("turn/completed", complete(123, "other")).events).toBeEmpty();
  expect(run("turn/completed", complete(123, root, "elsewhere")).events).toBeEmpty();
});
test("invalid native end holds the matching terminal for history and preserves its independently observed time", () => {
  for (const observed of [null, 1777777777777]) {
    for (const time of [undefined, null, -1, 1e19, 0.00001]) {
      const held = run("turn/completed", complete(time), initial(), observed);
      expect(held.lookup).toBe(true);
      expect(held.events).toBeEmpty();
      expect(run("turn/completed", complete(100, "foreign"), held.state).events).toBeEmpty();
      const ended = run("turn/completed", complete(1767225603), held.state, 1999999999999);
      expect(ended.events).toMatchObject([
        {
          kind: "roundEnded",
          endedAt: 1767225603000,
          endTimeEvidence: {
            source: "executorReported",
            executorEndedAt: 1767225603000,
            environmentObservedAt: observed,
          },
        },
      ]);
      expect(run("turn/completed", complete(2000000000), ended.state).events).toBeEmpty();
    }
  }
});
test("stdio handles split UTF-8 and multiple complete lines and rejects incomplete EOF", async () => {
  const bytes = new TextEncoder().encode("一\n2\n3\n");
  const stream = (parts: Uint8Array[]) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(p);
        controller.close();
      },
    });
  const lines: string[] = [];
  await readLines(stream([bytes.slice(0, 1), bytes.slice(1)]), (s) => lines.push(s));
  expect(lines).toEqual(["一", "2", "3"]);
  await expect(readLines(stream([bytes.slice(0, -1)]), () => {})).rejects.toThrow("Incomplete");
});
