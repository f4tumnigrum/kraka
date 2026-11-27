import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AttemptIdSchema,
  CheckpointCaptureSchema,
  CaptureIdSchema,
  CommandIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  NativeItemIdSchema,
  NativeRequestIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  QueuePositionSchema,
  PrincipalIdSchema,
  RoundIdSchema,
  RoundSchema,
  ThreadIdSchema,
  TodoRequestSchema,
  WorkNodeIdSchema,
  WorktreeIdSchema,
  type AnswerArrival,
  type AnswerProof,
  type RoundPhase,
  RoundPhaseSchema,
  type TodoAnswer,
  type TodoRoute,
  type TodoState,
} from "@kraka/protocol";
import {
  recoverInputDelivery,
  transitionInputQueue,
  transitionRound,
  transitionTodo,
  type AnswerEvent,
  type DeliveryRecovery,
  type InputQueue,
  type QueueEvent,
  type RoundReport,
  type TodoEvent,
  type TransitionResult,
} from "./index";

const ticket = {
  attemptId: v.parse(AttemptIdSchema, "first"),
  deliveryId: v.parse(DeliveryIdSchema, "first-ticket"),
};
const secondTicket = {
  attemptId: v.parse(AttemptIdSchema, "second"),
  deliveryId: v.parse(DeliveryIdSchema, "second-ticket"),
};
const sessionId = v.parse(NativeSessionIdSchema, "session");
const proof = { sessionId, itemId: v.parse(NativeItemIdSchema, "item") };
const root = { sessionId, id: v.parse(NativeRootTurnIdSchema, "root"), beganAt: 10 };
const captureId = v.parse(CaptureIdSchema, "capture");
const liveTarget = { sessionId, requestId: v.parse(NativeRequestIdSchema, "request") };
const messageId = v.parse(MessageIdSchema, "message");
const threadId = v.parse(ThreadIdSchema, "thread");
const cmd = v.parse(CommandIdSchema, "decision");
const nextAttempt = v.parse(AttemptIdSchema, "retry");
const nextDelivery = v.parse(DeliveryIdSchema, "retry-ticket");
const execution = { root, receipt: proof },
  closed = { ...execution, endedAt: 20 };
const phases = {
  filed: { kind: "filed", gate: "eligible" },
  armed: { kind: "armed" },
  handed: { kind: "handed", wroteAt: 9 },
  recovering: {
    kind: "recovering",
    gate: "eligible",
    action: "inspectInput",
    prior: { kind: "handed", wroteAt: 9 },
  },
  uncertain: { kind: "uncertain", next: "inspectInput" },
  received: { kind: "received", proof },
  working: { kind: "working", ...execution },
  unobserved: { kind: "unobserved", seen: { kind: "root", ...execution }, next: "inspectRoot" },
  closing: { kind: "closing", ...closed, captureId },
  finished: { kind: "finished", ...closed, captureId },
  endedEarly: { kind: "endedEarly", ...closed, reason: "failed" },
  notDelivered: { kind: "notDelivered", reason: "userAbandoned", lateReceipt: null },
} satisfies Record<RoundPhase["kind"], RoundPhase>;
const reports = {
  written: { ...ticket, kind: "written", at: 9 },
  received: { ...ticket, kind: "received", proof },
  unknown: { ...ticket, kind: "unknown" },
  refused: { ...ticket, kind: "refused", reason: "refused" },
  absentAfterFence: { ...ticket, kind: "absentAfterFence" },
  observationLost: { ...ticket, kind: "observationLost" },
  rootStarted: { ...ticket, kind: "rootStarted", root },
  rootEnded: { ...ticket, kind: "rootEnded", root, endedAt: 20, outcome: "completed", captureId },
  captureSettled: {
    ...ticket,
    kind: "captureSettled",
    capture: {
      id: captureId,
      roundId: v.parse(RoundIdSchema, "round"),
      attemptId: ticket.attemptId,
      result: { kind: "ready", worktreeId: v.parse(WorktreeIdSchema, "worktree") },
      version: v.parse(ObjectVersionSchema, "1"),
    },
  },
} satisfies Record<RoundReport["kind"], RoundReport>;

function accepted<T>(result: TransitionResult<T>): T {
  if (result.kind === "rejected") throw Error(`Unexpected refusal: ${result.reason}`);
  return result.value;
}
type Destinations<S extends string, E extends string> = Record<S, Partial<Record<E, S>>>;
// Empty cells are business refusals. Each entry names the observable destination.
const roundDestinations: Destinations<RoundPhase["kind"], RoundReport["kind"]> = {
  filed: {},
  armed: {
    written: "handed",
    received: "received",
    unknown: "uncertain",
    refused: "notDelivered",
    rootStarted: "working",
    rootEnded: "closing",
  },
  handed: {
    written: "handed",
    received: "received",
    unknown: "uncertain",
    refused: "notDelivered",
    rootStarted: "working",
    rootEnded: "closing",
  },
  recovering: {
    received: "received",
    unknown: "uncertain",
    refused: "notDelivered",
    absentAfterFence: "filed",
    rootStarted: "working",
    rootEnded: "closing",
  },
  uncertain: {
    received: "received",
    unknown: "uncertain",
    refused: "notDelivered",
    rootStarted: "working",
    rootEnded: "closing",
  },
  received: {
    received: "received",
    rootStarted: "working",
    rootEnded: "closing",
    observationLost: "unobserved",
  },
  working: {
    received: "working",
    observationLost: "unobserved",
    rootStarted: "working",
    rootEnded: "closing",
  },
  unobserved: {
    received: "unobserved",
    unknown: "unobserved",
    observationLost: "unobserved",
    rootStarted: "working",
    rootEnded: "closing",
  },
  closing: { received: "closing", rootEnded: "closing", captureSettled: "finished" },
  finished: { received: "finished", rootEnded: "finished", captureSettled: "finished" },
  endedEarly: { received: "endedEarly" },
  notDelivered: { received: "notDelivered" },
};
for (const phase of Object.values(phases)) {
  test(`round reports accepted from ${phase.kind}`, () => {
    for (const event of Object.values(reports)) {
      const result = transitionRound({ ...ticket, phase }, event);
      expect(result.kind === "ok" ? result.value.kind : "rejected", event.kind).toBe(
        roundDestinations[phase.kind][event.kind] ?? "rejected",
      );
    }
  });
}
test("a child ending or a stale attempt cannot close the root", () => {
  const working = { ...ticket, phase: phases.working };
  expect(
    transitionRound(working, {
      ...reports.rootEnded,
      root: { ...root, id: v.parse(NativeRootTurnIdSchema, "child") },
    }),
  ).toEqual({ kind: "rejected", reason: "wrongNativeRoot" });
  expect(
    transitionRound(working, { ...reports.rootEnded, attemptId: secondTicket.attemptId }),
  ).toEqual({ kind: "rejected", reason: "wrongAttempt" });
  expect(
    transitionRound(working, { ...reports.rootEnded, deliveryId: secondTicket.deliveryId }),
  ).toEqual({ kind: "rejected", reason: "wrongDelivery" });
  expect(transitionRound(working, { ...reports.rootEnded, endedAt: 0 })).toEqual({
    kind: "rejected",
    reason: "invalidState",
  });
  expect(
    transitionRound(
      { ...ticket, phase: phases.closing },
      {
        ...reports.captureSettled,
        capture: { ...reports.captureSettled.capture, id: v.parse(CaptureIdSchema, "other") },
      },
    ),
  ).toEqual({ kind: "rejected", reason: "wrongCapture" });
});
test("a receipt cannot be joined to a root in a different native session", () => {
  const otherSessionRoot = {
    ...root,
    sessionId: v.parse(NativeSessionIdSchema, "other-session"),
  };
  expect(
    transitionRound(
      { ...ticket, phase: phases.received },
      {
        ...reports.rootStarted,
        root: otherSessionRoot,
      },
    ),
  ).toEqual({ kind: "rejected", reason: "wrongNativeRoot" });
  const lost = accepted(
    transitionRound({ ...ticket, phase: phases.received }, reports.observationLost),
  );
  expect(
    transitionRound({ ...ticket, phase: lost }, { ...reports.rootStarted, root: otherSessionRoot }),
  ).toEqual({ kind: "rejected", reason: "wrongNativeRoot" });
});
test("replayed native evidence keeps the first timestamps and matching capture", () => {
  const attempt = { ...ticket, phase: phases.working };
  const replayRoot = { ...root, beganAt: 15 };
  expect(accepted(transitionRound(attempt, { ...reports.rootStarted, root: replayRoot }))).toEqual(
    phases.working,
  );
  const closing = accepted(transitionRound(attempt, { ...reports.rootEnded, root: replayRoot }));
  expect(closing).toEqual(phases.closing);
  expect(
    accepted(transitionRound({ ...ticket, phase: closing }, { ...reports.rootEnded, endedAt: 30 })),
  ).toEqual(closing);
  for (const outcome of ["failed", "stopped", "lost"] as const) {
    const end = { ...ticket, kind: "rootEnded", root, outcome, endedAt: 20 } satisfies RoundReport;
    const early = accepted(transitionRound(attempt, end));
    expect(early).toEqual({ ...phases.endedEarly, reason: outcome });
    expect(accepted(transitionRound({ ...ticket, phase: early }, end))).toEqual(early);
  }
});
test("inspection can close a previously received input even when observation was lost before root start", () => {
  const lost = accepted(
    transitionRound({ ...ticket, phase: phases.received }, reports.observationLost),
  );
  expect(accepted(transitionRound({ ...ticket, phase: lost }, reports.rootEnded))).toEqual(
    phases.closing,
  );
  expect(
    transitionRound(
      { ...ticket, phase: lost },
      {
        ...reports.rootStarted,
        root: { ...root, sessionId: v.parse(NativeSessionIdSchema, "other") },
      },
    ).kind,
  ).toBe("rejected");
});

const recoveries: DeliveryRecovery[] = ["none", "query", "deduplicate"];
test("restart distinguishes held human input, query-only recovery, and safe ticket reuse in every phase", () => {
  for (const phase of Object.values(phases))
    for (const source of ["person", "automation"] as const)
      for (const recovery of recoveries) {
        const next = recoverInputDelivery(phase, source, recovery);
        const gate = source === "person" ? "held" : "eligible";
        switch (phase.kind) {
          case "filed":
            expect(next).toEqual(
              source === "automation" && recovery === "none"
                ? phases.uncertain
                : { kind: "filed", gate },
            );
            break;
          case "armed":
          case "handed":
          case "recovering":
            expect(next).toEqual(
              recovery === "none"
                ? phases.uncertain
                : {
                    kind: "recovering",
                    prior: phase.kind === "recovering" ? phase.prior : phase,
                    gate,
                    action: recovery === "query" ? "inspectInput" : "retrySameDelivery",
                  },
            );
            break;
          case "received":
            expect(next).toEqual({
              kind: "unobserved",
              next: "inspectRoot",
              seen: { kind: "input", proof },
            });
            break;
          case "working":
            expect(next).toEqual(phases.unobserved);
            break;
          default:
            expect(next).toEqual(phase);
        }
      }
});

function queue(phase: RoundPhase, source: "person" | "automation" = "person"): InputQueue {
  const row = {
    id: v.parse(RoundIdSchema, "r"),
    messageId,
    place: v.parse(QueuePositionSchema, "9"),
    source,
    attempt: { ...ticket, phase },
    previous: [],
  };
  return {
    threadId,
    decisions: [],
    rows: [
      {
        ...row,
        id: v.parse(RoundIdSchema, "s"),
        place: v.parse(QueuePositionSchema, "10"),
        messageId: v.parse(MessageIdSchema, "later"),
        attempt: { ...secondTicket, phase: phases.filed },
      },
      row,
    ],
  };
}
function step(q: InputQueue, event: QueueEvent) {
  return accepted(transitionInputQueue(q, event));
}
const claim = { kind: "claim", target: ticket.attemptId } as const;
const resend = {
  kind: "resend",
  commandId: cmd,
  target: ticket.attemptId,
  newAttemptId: nextAttempt,
  newDeliveryId: nextDelivery,
} as const;
const drop = { kind: "drop", commandId: cmd, target: ticket.attemptId } as const;
test("a human queue survives two restarts and can only dispatch after release", () => {
  let q = queue(phases.filed);
  const restart = { kind: "restart", capabilities: new Map() } satisfies QueueEvent;
  q = step(step(q, restart), restart);
  expect(
    q.rows.map((r) => ({
      place: String(r.place),
      phase: r.attempt.phase.kind === "filed" ? r.attempt.phase : r.attempt.phase.kind,
    })),
  ).toMatchObject([
    { place: "10", phase: { kind: "filed", gate: "held" } },
    { place: "9", phase: { kind: "filed", gate: "held" } },
  ]);
  expect(transitionInputQueue(q, claim)).toEqual({ kind: "rejected", reason: "queueHeld" });
  expect(step(step(q, { kind: "release" }), claim).rows[1]?.attempt.phase).toEqual(phases.armed);
});
test("an unknown head blocks release and every later claim until a numbered drop", () => {
  const q = queue(phases.uncertain);
  expect(transitionInputQueue(q, { kind: "claim", target: secondTicket.attemptId })).toEqual({
    kind: "rejected",
    reason: "notQueueHead",
  });
  expect(transitionInputQueue(q, { kind: "release" })).toEqual({
    kind: "rejected",
    reason: "queueHeld",
  });
  const advanced = step(step(q, drop), { kind: "claim", target: secondTicket.attemptId });
  expect(advanced.rows[0]?.attempt.phase).toEqual(phases.armed);
  expect(step(advanced, drop)).toEqual(advanced);
  expect(transitionInputQueue(advanced, resend)).toEqual({
    kind: "rejected",
    reason: "idConflict",
  });
  expect(
    step(advanced, { kind: "report", report: reports.received }).rows[1]?.attempt.phase,
  ).toEqual({ kind: "notDelivered", reason: "userAbandoned", lateReceipt: proof });
});
test("a retried resend returns the original decision after progress, and a late receipt touches only its original attempt", () => {
  const before = queue(phases.uncertain);
  const resent = step(before, resend);
  expect(resent.decisions).toEqual([resend]);
  expect(resent.rows[1]?.attempt).toEqual({
    attemptId: nextAttempt,
    deliveryId: nextDelivery,
    phase: phases.filed,
  });
  const claimed = step(resent, { kind: "claim", target: nextAttempt });
  const reconciled = step(claimed, { kind: "report", report: reports.received });
  expect(reconciled.rows[1]?.previous).toEqual([{ ...ticket, phase: phases.received }]);
  expect(reconciled.rows[1]?.attempt.phase).toEqual(phases.armed);
  expect(step(reconciled, resend)).toEqual(reconciled);
  expect(transitionInputQueue(reconciled, { ...resend, target: secondTicket.attemptId })).toEqual({
    kind: "rejected",
    reason: "idConflict",
  });
  expect(transitionInputQueue(before, { ...resend, newAttemptId: secondTicket.attemptId })).toEqual(
    { kind: "rejected", reason: "idConflict" },
  );
  expect(before.rows[1]?.previous).toEqual([]);
});
test("query-only recovery cannot write again until the old sender is fenced and absence established", () => {
  const restart = {
    kind: "restart",
    capabilities: new Map([[ticket.attemptId, "query"]]),
  } satisfies QueueEvent;
  const q = step(queue(phases.handed, "automation"), restart);
  expect(transitionInputQueue(q, claim).kind).toBe("rejected");
  const found = step(q, { kind: "report", report: reports.received });
  expect(found.rows[1]?.attempt.phase).toEqual(phases.received);
  const absent = step(q, { kind: "report", report: reports.absentAfterFence });
  expect(step(absent, claim).rows[1]?.attempt).toEqual({ ...ticket, phase: phases.armed });
  const human = step(queue(phases.handed), restart);
  expect(
    transitionInputQueue(step(human, { kind: "report", report: reports.absentAfterFence }), claim)
      .kind,
  ).toBe("rejected");
});
test("safe automated retry claims the same ticket, and the same human retry waits for release", () => {
  const restart = {
    kind: "restart",
    capabilities: new Map([[ticket.attemptId, "deduplicate"]]),
  } satisfies QueueEvent;
  const human = step(queue(phases.armed), restart);
  expect(transitionInputQueue(human, claim)).toEqual({ kind: "rejected", reason: "queueHeld" });
  expect(step(step(human, { kind: "release" }), claim).rows[1]?.attempt).toEqual({
    ...ticket,
    phase: phases.armed,
  });
  expect(step(step(queue(phases.armed, "automation"), restart), claim).rows[1]?.attempt).toEqual({
    ...ticket,
    phase: phases.armed,
  });
});

test("every queue state handles every command and adapter report according to its current head", () => {
  const queuePhases: readonly RoundPhase[] = Object.values(phases);
  const commandEvents: readonly QueueEvent[] = [
    { kind: "restart", capabilities: new Map() },
    { kind: "release" },
    { kind: "claim", target: ticket.attemptId },
    resend,
    drop,
    ...Object.values(reports).map((report) => ({ kind: "report" as const, report })),
  ];
  for (const phase of queuePhases) {
    for (const event of commandEvents) {
      const completeQueue = queue(phase);
      const singleHeadQueue = {
        ...completeQueue,
        rows: completeQueue.rows.filter((row) => row.attempt.attemptId === ticket.attemptId),
      };
      const result = transitionInputQueue(singleHeadQueue, event);
      let expected: "ok" | "rejected";
      switch (event.kind) {
        case "restart":
          expected = "ok";
          break;
        case "release":
          expected = phase.kind === "uncertain" ? "rejected" : "ok";
          break;
        case "claim":
          expected =
            (phase.kind === "filed" && phase.gate === "eligible") ||
            (phase.kind === "recovering" &&
              phase.gate === "eligible" &&
              phase.action === "retrySameDelivery")
              ? "ok"
              : "rejected";
          break;
        case "resend":
        case "drop":
          expected = phase.kind === "uncertain" ? "ok" : "rejected";
          break;
        case "report":
          expected = roundDestinations[phase.kind][event.report.kind] ? "ok" : "rejected";
          break;
        default:
          expected = "rejected";
      }
      expect(result.kind, `${phase.kind} with ${event.kind}`).toBe(expected);
    }
  }
});

const nodeId = v.parse(WorkNodeIdSchema, "node");
const live = {
  kind: "live",
  subject: "approval",
  ...liveTarget,
  fallback: { kind: "expire" },
} satisfies TodoRoute;
const question = {
  ...live,
  subject: "question",
  fallback: { kind: "asMessage", nodeId, questions: [messageId] },
} satisfies TodoRoute;
const content = { kind: "message", messageId } as const;
const answer = {
  ...ticket,
  authorId: v.parse(PrincipalIdSchema, "owner"),
  at: 11,
  content,
} satisfies TodoAnswer;
const answerProof = { ...liveTarget } satisfies AnswerProof;
const arrivals = {
  viaMessage: { kind: "viaMessage" },
  recorded: { kind: "recorded" },
  armed: { kind: "armed" },
  handed: { kind: "handed", wroteAt: 12 },
  uncertain: { kind: "uncertain", next: "inspectAnswer" },
  received: { kind: "received", proof: answerProof },
  rejected: { kind: "rejected", reason: "gone" },
} satisfies Record<AnswerArrival["kind"], AnswerArrival>;
const answers = {
  claim: { ...ticket, kind: "claim" },
  written: { ...ticket, kind: "written", at: 12 },
  received: { ...ticket, kind: "received", proof: answerProof },
  unknown: { ...ticket, kind: "unknown" },
  refused: { ...ticket, kind: "refused", reason: "gone" },
  redeliver: {
    ...ticket,
    kind: "redeliver",
    request: liveTarget,
    oldPathClosed: true,
    newAttemptId: nextAttempt,
    newDeliveryId: nextDelivery,
  },
} satisfies Record<AnswerEvent["kind"], AnswerEvent>;
const answerDestinations: Destinations<AnswerArrival["kind"], AnswerEvent["kind"]> = {
  viaMessage: {},
  recorded: { claim: "armed" },
  armed: { written: "handed", received: "received", unknown: "uncertain", refused: "rejected" },
  handed: { written: "handed", received: "received", unknown: "uncertain", refused: "rejected" },
  uncertain: {
    received: "received",
    unknown: "uncertain",
    refused: "rejected",
    redeliver: "recorded",
  },
  received: { received: "received" },
  rejected: {},
};
for (const arrival of Object.values(arrivals)) {
  test(`recorded answer accepts only matching delivery updates from ${arrival.kind}`, () => {
    const state = {
      kind: "answered",
      route: live,
      answer,
      arrival,
      previousAttempts: [],
    } satisfies TodoState;
    for (const event of Object.values(answers)) {
      const result = transitionTodo(state, { kind: "delivery", event });
      const destination =
        result.kind === "ok" && result.value.kind === "answered"
          ? result.value.arrival.kind
          : "refusal";
      expect(destination, event.kind).toBe(
        answerDestinations[arrival.kind][event.kind] ?? "refusal",
      );
      if (result.kind === "ok" && result.value.kind === "answered") {
        expect(result.value.answer.content).toEqual(content);
        if (result.value.arrival.kind === "received")
          expect(result.value.arrival.proof).toEqual(answerProof);
      }
    }
  });
}
const lost = {
  kind: "sessionLost",
  sessionId,
  reason: "gone",
  messageFallback: { nodeId, questions: [{ id: messageId, text: "Continue?" }] },
} satisfies TodoEvent;
test("the first answer wins on both devices and session loss preserves its outcome", () => {
  const open = { kind: "open", route: live } satisfies TodoState;
  const accept = { kind: "answer", answer, target: liveTarget } satisfies TodoEvent;
  const winner = accepted(transitionTodo(open, accept));
  expect(winner).toEqual({
    kind: "answered",
    route: live,
    answer,
    arrival: arrivals.recorded,
    previousAttempts: [],
  });
  expect(transitionTodo(winner, accept)).toEqual({ kind: "rejected", reason: "alreadyAnswered" });
  expect(transitionTodo(winner, lost)).toMatchObject({
    kind: "ok",
    value: {
      kind: "answered",
      answer,
      arrival: { kind: "rejected", reason: "session-lost-before-delivery" },
    },
  });
  const claimed = accepted(transitionTodo(winner, { kind: "delivery", event: answers.claim }));
  const inFlight = accepted(transitionTodo(claimed, lost));
  expect(inFlight).toMatchObject({
    kind: "answered",
    answer,
    arrival: { kind: "uncertain", next: "inspectAnswer" },
  });
  const expired = accepted(transitionTodo(open, lost));
  expect(expired).toEqual({ kind: "expired", reason: "gone" });
  expect(transitionTodo(expired, accept).kind).toBe("rejected");
  expect(transitionTodo(open, { ...accept, target: null }).kind).toBe("rejected");
  expect(transitionTodo(open, { kind: "delivery", event: answers.claim }).kind).toBe("rejected");
  expect(transitionTodo(expired, { kind: "delivery", event: answers.claim }).kind).toBe("rejected");
  expect(accepted(transitionTodo(expired, lost))).toEqual(expired);
});

test("redelivery keeps attempt history and applies a late receipt only to the old attempt", () => {
  const open = { kind: "open", route: live } satisfies TodoState;
  const winner = accepted(transitionTodo(open, { kind: "answer", answer, target: liveTarget }));
  const claimed = accepted(transitionTodo(winner, { kind: "delivery", event: answers.claim }));
  const unknown = accepted(transitionTodo(claimed, lost));
  expect(accepted(transitionTodo(unknown, lost))).toEqual(unknown);
  const redeliverEvent = { kind: "delivery", event: answers.redeliver } satisfies TodoEvent;
  const redelivered = accepted(transitionTodo(unknown, redeliverEvent));

  expect(redelivered).toMatchObject({
    kind: "answered",
    answer: { attemptId: nextAttempt, deliveryId: nextDelivery },
    arrival: { kind: "recorded" },
    previousAttempts: [
      {
        attemptId: ticket.attemptId,
        deliveryId: ticket.deliveryId,
        arrival: { kind: "uncertain" },
      },
    ],
  });
  expect(accepted(transitionTodo(redelivered, redeliverEvent))).toEqual(redelivered);

  const lateReceipt = { ...answers.received };
  const reconciled = accepted(
    transitionTodo(redelivered, {
      kind: "delivery",
      event: { ...lateReceipt, attemptId: ticket.attemptId, deliveryId: ticket.deliveryId },
    }),
  );
  expect(reconciled).toMatchObject({
    kind: "answered",
    answer: { attemptId: nextAttempt, deliveryId: nextDelivery },
    arrival: { kind: "recorded" },
    previousAttempts: [{ arrival: { kind: "received", proof: answerProof } }],
  });
});
test("only a readable question on the same node can fall back to an ordinary message", () => {
  const open = { kind: "open", route: question } satisfies TodoState;
  for (const messageFallback of [
    null,
    { nodeId, questions: [] },
    { nodeId, questions: [{ id: messageId, text: " " }] },
    { nodeId: v.parse(WorkNodeIdSchema, "other"), questions: lost.messageFallback.questions },
  ]) {
    expect(accepted(transitionTodo(open, { ...lost, messageFallback })).kind).toBe("expired");
  }
  const converted = accepted(transitionTodo(open, lost));
  expect(converted).toEqual({
    kind: "open",
    route: { kind: "message", subject: "question", nodeId, questions: [messageId] },
  });
  expect(accepted(transitionTodo(converted, lost))).toEqual(converted);
  const recorded = accepted(transitionTodo(converted, { kind: "answer", answer, target: null }));
  expect(recorded).toMatchObject({
    kind: "answered",
    arrival: { kind: "viaMessage" },
    answer: { content },
  });
  expect(transitionTodo(recorded, { kind: "delivery", event: answers.claim })).toEqual({
    kind: "rejected",
    reason: "routeUnavailable",
  });
});
test("secret requests accept only an opaque secret-storage receipt", () => {
  const open = { kind: "open", route: { ...live, subject: "secret" } } satisfies TodoState;
  expect(transitionTodo(open, { kind: "answer", target: liveTarget, answer }).kind).toBe(
    "rejected",
  );
  const stored = accepted(
    transitionTodo(open, {
      kind: "answer",
      target: liveTarget,
      answer: { ...answer, content: { kind: "secretReceipt", commandId: cmd } },
    }),
  );
  expect(stored).toMatchObject({
    kind: "answered",
    answer: { content: { kind: "secretReceipt", commandId: cmd } },
  });
});
test("wrong tickets, attempts and native requests cannot confirm an answer", () => {
  const state = {
    kind: "answered",
    route: live,
    answer,
    arrival: arrivals.armed,
    previousAttempts: [],
  } satisfies TodoState;
  for (const event of [
    { ...answers.received, attemptId: nextAttempt },
    { ...answers.received, deliveryId: nextDelivery },
    {
      ...answers.received,
      proof: { ...answerProof, requestId: v.parse(NativeRequestIdSchema, "other") },
    },
  ]) {
    expect(transitionTodo(state, { kind: "delivery", event }).kind).toBe("rejected");
  }
});
test("a client can decode the round's actual current phase and the accepted answer's delivery status", () => {
  const base = {
    id: "round",
    threadId: "thread",
    version: "9007199254740993",
    messageId: "body",
    place: "9",
  };
  for (const phase of Object.values(phases)) {
    const wire = JSON.parse(JSON.stringify({ ...base, attempt: { ...ticket, phase } }));
    expect(v.parse(RoundSchema, wire).attempt.phase).toEqual(phase);
  }
  const captureResults: Array<v.InferOutput<typeof CheckpointCaptureSchema>["result"]> = [
    { kind: "ready", worktreeId: v.parse(WorktreeIdSchema, "worktree") },
    { kind: "missing" },
    { kind: "error", reason: "workspace unavailable" },
  ];
  for (const result of captureResults) {
    expect(
      v.parse(CheckpointCaptureSchema, {
        id: "capture",
        roundId: "round",
        attemptId: "first",
        result,
        version: "1",
      }).result,
    ).toEqual(result);
  }
  expect(
    v.safeParse(RoundSchema, { ...base, attempt: { ...ticket, phase: { kind: "futurePhase" } } })
      .success,
  ).toBe(false);
  for (const arrival of Object.values(arrivals)) {
    const state = {
      kind: "answered",
      route: live,
      answer,
      arrival,
      previousAttempts: [],
    } satisfies TodoState;
    expect(
      v.parse(TodoRequestSchema, {
        id: "todo",
        roundId: "round",
        threadId: "thread",
        version: "10",
        body: { kind: "approval", tool: "command", choices: [] },
        state,
      }).state,
    ).toEqual(state);
  }
});

test("a correlated terminal reply preserves an unobserved start and the native end reason", () => {
  const end = { ...reports.rootEnded, root: { ...root, beganAt: null } };
  for (const outcome of ["superseded", "unknown"] as const) {
    const report = { ...end, outcome, nativeReason: "peer replaced task" };
    const phase = accepted(transitionRound({ ...ticket, phase: phases.handed }, report));
    expect(phase).toEqual({
      kind: "endedEarly",
      root: end.root,
      receipt: null,
      endedAt: end.endedAt,
      nativeReason: report.nativeReason,
      reason: outcome,
    });
    expect(accepted(transitionRound({ ...ticket, phase }, report))).toEqual(phase);
  }
});

test("round completion persists observed and executor times independently through replay and capture", () => {
  const evidence = {
    source: "environmentObserved",
    executorEndedAt: null,
    environmentObservedAt: 20,
  } as const;
  const report = { ...reports.rootEnded, endTimeEvidence: evidence };
  const closing = accepted(transitionRound({ ...ticket, phase: phases.handed }, report));
  expect(closing).toMatchObject({ endedAt: 20, endTimeEvidence: evidence });
  const persisted = v.parse(RoundPhaseSchema, JSON.parse(JSON.stringify(closing)));
  const finished = accepted(
    transitionRound({ ...ticket, phase: persisted }, reports.captureSettled),
  );
  expect(finished).toMatchObject({ kind: "finished", endTimeEvidence: evidence });
  expect(
    accepted(
      transitionRound(
        { ...ticket, phase: finished },
        {
          ...report,
          endedAt: 30,
          endTimeEvidence: {
            source: "executorReported",
            executorEndedAt: 30,
            environmentObservedAt: 31,
          },
        },
      ),
    ),
  ).toEqual(finished);
  expect(transitionRound({ ...ticket, phase: phases.handed }, { ...report, endedAt: 21 })).toEqual({
    kind: "rejected",
    reason: "invalidState",
  });
});

test("executor time remains independent of observation time on early termination", () => {
  const evidence = {
    source: "executorReported",
    executorEndedAt: 20,
    environmentObservedAt: 35,
  } as const;
  const report = { ...reports.rootEnded, outcome: "stopped", endTimeEvidence: evidence } as const;
  const early = accepted(transitionRound({ ...ticket, phase: phases.working }, report));
  expect(v.parse(RoundPhaseSchema, JSON.parse(JSON.stringify(early)))).toMatchObject({
    kind: "endedEarly",
    endedAt: 20,
    endTimeEvidence: evidence,
  });
  expect(transitionRound({ ...ticket, phase: phases.working }, { ...report, endedAt: 35 })).toEqual(
    { kind: "rejected", reason: "invalidState" },
  );
  expect(v.parse(RoundPhaseSchema, phases.finished)).not.toHaveProperty("endTimeEvidence");
});
