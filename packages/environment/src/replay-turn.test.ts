import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CapabilityMatrixSchema,
  ReplayRunRequestSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  NativeItemIdSchema,
  AttemptIdSchema,
  ExecutorInstanceIdSchema,
  type CommandReceipt,
  type ReplayTurnUpdate,
} from "@kraka/protocol";
import type {
  ProviderAdapter,
  AdapterEventEnvelope,
  AdapterCommand,
  AdapterSession,
  AdapterInstance,
  ActionPermit,
  AdapterCapability,
  AdapterCallResult,
  InstanceServiceCommand,
  SessionInvocationResult,
  InvocationResult,
  CloseReason,
  CapabilityDeclaration,
} from "./adapter-contract";
import { runReplayTurn } from "./replay-turn";

const request = v.parse(ReplayRunRequestSchema, {
  kind: "replay.run",
  commandId: "run",
  permission: "ask",
  input: { text: "fixture", references: [], attachments: [] },
});
const sessionId = v.parse(NativeSessionIdSchema, "session"),
  root = v.parse(NativeRootTurnIdSchema, "root"),
  item = v.parse(NativeItemIdSchema, "answer"),
  callId = v.parse(NativeItemIdSchema, "call");
const yes = { state: "yes", verifiedAt: 100 } as const,
  none = { receipt: "none", deduplicate: "none", query: "none" } as const;
const unsupported = { kind: "unsupported", reason: "fixture" } as const,
  steering = { support: unsupported, readReceipt: "no", accepts: [] } as const;
const declaration: CapabilityDeclaration<"replay"> = {
  family: "replay",
  version: 1,
  checkedAt: 100,
  readiness: { configured: yes, installed: yes, authenticated: yes, model: yes, operation: yes },
  matrix: v.parse(
    CapabilityMatrixSchema,
    Object.fromEntries(CAPABILITY_IDS.map((id) => [id, { kind: "native" }])),
  ),
  input: none,
  answer: none,
  steering: { queueNext: steering, insertCurrent: steering, restartCurrent: steering },
  requests: {
    approval: { afterSessionLoss: "notResumable" },
    question: { afterSessionLoss: "notResumable" },
  },
  permission: { modes: ["ask"], enforcement: "adapter", changeEffective: "now" },
  endReasons: ["completed"],
  childWork: "unsupported",
};
type Handle = { attemptId: v.InferOutput<typeof AttemptIdSchema> };
type Session = AdapterSession<"replay", Handle>;
type Event = AdapterEventEnvelope<"replay">;
function peer(transform: (e: Event) => Event[] = (e) => [e]) {
  const reached = Promise.withResolvers<void>(),
    first = Promise.withResolvers<void>(),
    write = Promise.withResolvers<void>(),
    opening = Promise.withResolvers<void>(),
    openGate = Promise.withResolvers<void>();
  const closed: CloseReason[] = [];
  async function invoke<C extends InstanceServiceCommand>(
    target: AdapterInstance<"replay">,
    permit: ActionPermit<"replay", NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<never>>;
  async function invoke<C extends AdapterCommand>(
    target: Session,
    permit: ActionPermit<"replay", NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    _target: AdapterInstance<"replay">,
    _permit: ActionPermit<"replay", AdapterCapability>,
    command: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult>> {
    await write.promise;
    return { kind: "ok", value: { kind: "written", deliveryId: command.deliveryId } };
  }
  const adapter: ProviderAdapter<"replay", Handle> = {
    async capabilities() {
      return { kind: "ok", value: declaration };
    },
    async open({ instance, attemptId, setup }) {
      opening.resolve();
      await openGate.promise;
      expect(setup).toEqual({
        model: { id: "model", options: {} },
        permission: { ceiling: "ask", selected: "ask" },
        workingDirectory: "state",
        environment: {},
        additionalDirectories: [],
      });
      return {
        kind: "ok",
        value: { ...instance, nativeSessionId: sessionId, epoch: 1, handle: { attemptId } },
      };
    },
    invoke,
    async *events(s) {
      const { attemptId } = s.handle;
      reached.resolve();
      await first.promise;
      const facts: Event["payload"][] = [
        { kind: "roundStarted", attemptId, nativeRootTurnId: root, at: 100 },
        {
          kind: "toolActivity",
          attemptId,
          callId,
          phase: "started",
          input: { command: "echo" },
          output: null,
        },
        {
          kind: "toolActivity",
          attemptId,
          callId,
          phase: "progress",
          input: null,
          output: { text: "hi\n" },
        },
        {
          kind: "toolActivity",
          attemptId,
          callId,
          phase: "ended",
          input: null,
          output: { text: "hi\n", exitCode: 0 },
        },
        {
          kind: "contentDelta",
          attemptId,
          itemId: item,
          role: "assistant",
          text: "first ",
          finalText: null,
        },
        {
          kind: "contentDelta",
          attemptId,
          itemId: item,
          role: "assistant",
          text: "second",
          finalText: null,
        },
        {
          kind: "contentDelta",
          attemptId,
          itemId: item,
          role: "assistant",
          text: "",
          finalText: "first second",
        },
        {
          kind: "roundEnded",
          attemptId,
          nativeRootTurnId: root,
          endedAt: 200,
          endTimeEvidence: {
            source: "executorReported",
            executorEndedAt: 200,
            environmentObservedAt: null,
          },
          outcome: { reason: "completed", nativeReason: null },
        },
      ];
      for (const [i, payload] of facts.entries()) {
        const event: Event = {
          family: s.family,
          instanceId: s.instanceId,
          sessionId,
          epoch: 1,
          eventId: String([9, 12, 13, 14, 16, 17, 18, 19][i]),
          payload,
        };
        yield* transform(event);
      }
    },
    async close(_s, reason) {
      closed.push(reason);
      first.resolve();
      write.resolve();
      return { kind: "ok", value: undefined };
    },
  };
  const messages: (CommandReceipt | ReplayTurnUpdate)[] = [];
  const controller = new AbortController();
  const run = () =>
    runReplayTurn({
      request,
      adapter,
      expectedText: "fixture",
      modelId: "model",
      workingDirectory: "state",
      signal: controller.signal,
      emit: (m) => messages.push(m),
    });
  return { adapter, run, reached, first, write, opening, openGate, controller, messages, closed };
}
for (const firstIsEarly of [false, true]) {
  test(
    firstIsEarly
      ? "a buffered native start waits for the matching write"
      : "writing input does not start a round until native frame 9",
    async () => {
      const p = peer((e) => [e, { ...e }]);
      p.openGate.resolve();
      const done = p.run();
      await p.reached.promise;
      if (firstIsEarly) p.first.resolve();
      else p.write.resolve();
      await Bun.sleep(0);
      expect(p.messages.map((m) => m.kind)).toEqual(["accepted"]);
      p.write.resolve();
      p.first.resolve();
      await done;
      expect(p.messages.map((m) => m.kind)).toEqual([
        "accepted",
        "round.started",
        "tool.started",
        "tool.output",
        "tool.ended",
        "assistant.delta",
        "assistant.delta",
        "assistant.final",
        "round.ended",
      ]);
      expect(p.messages[1]).toMatchObject({
        nativeSessionId: sessionId,
        nativeRootTurnId: root,
        startedAt: 100,
        phase: "working",
        selectedMode: "ask",
        effectiveMode: "ask",
        supportedModes: ["ask"],
        enforcement: "adapter",
      });
      expect(p.closed).toEqual(["finished"]);
    },
  );
}
test("foreign envelopes, attempts, roots and contradictory evidence cannot complete a turn", async () => {
  const mutations: ((e: Event) => Event[])[] = [
    (e) => [{ ...e, instanceId: v.parse(ExecutorInstanceIdSchema, "other") }],
    (e) => [{ ...e, epoch: 2 }],
    (e) => [{ ...e, sessionId: v.parse(NativeSessionIdSchema, "other") }],
    (e) =>
      e.payload.kind === "roundEnded"
        ? [{ ...e, payload: { ...e.payload, attemptId: v.parse(AttemptIdSchema, "other") } }]
        : [e],
    (e) =>
      e.payload.kind === "roundEnded"
        ? [
            {
              ...e,
              payload: { ...e.payload, nativeRootTurnId: v.parse(NativeRootTurnIdSchema, "other") },
            },
          ]
        : [e],
    (e) =>
      e.payload.kind === "roundEnded" ? [{ ...e, payload: { ...e.payload, endedAt: 300 } }] : [e],
    (e) =>
      e.payload.kind === "roundStarted" ? [e, { ...e, payload: { ...e.payload, at: 120 } }] : [e],
  ];
  for (const mutation of mutations) {
    const p = peer(mutation);
    p.openGate.resolve();
    p.first.resolve();
    p.write.resolve();
    await expect(p.run()).rejects.toThrow();
    expect(p.messages.filter((m) => m.kind === "accepted")).toHaveLength(1);
    expect(p.messages.some((m) => m.kind === "round.ended")).toBe(false);
    expect(p.closed).toEqual(["shutdown"]);
  }
});
test("cancellation releases a blocked reader and a late-opened handle exactly once", async () => {
  for (const lateOpen of [true, false]) {
    const p = peer();
    const done = p.run();
    await p.opening.promise;
    if (!lateOpen) {
      p.openGate.resolve();
      await p.reached.promise;
    }
    p.controller.abort();
    p.openGate.resolve();
    await expect(done).rejects.toThrow();
    expect(p.closed).toEqual(["shutdown"]);
    expect(p.messages.map((m) => m.kind)).toEqual(lateOpen ? [] : ["accepted"]);
  }
});
