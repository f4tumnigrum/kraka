import type {
  AnswerArrival,
  AnswerProof,
  AttemptId,
  DeliveryId,
  MessageId,
  NativeRequestId,
  NativeSessionId,
  TodoAnswer,
  TodoRoute,
  TodoState,
  WorkNodeId,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";

type NativeTarget = { sessionId: NativeSessionId; requestId: NativeRequestId };
type MessageFallback = {
  nodeId: WorkNodeId;
  questions: readonly { id: MessageId; text: string }[];
};
export type AnswerEvent = { attemptId: AttemptId; deliveryId: DeliveryId } & (
  | { kind: "claim" }
  | { kind: "written"; at: number }
  | { kind: "received"; proof: AnswerProof }
  | { kind: "unknown" }
  | { kind: "refused"; reason: string }
  | {
      kind: "redeliver";
      request: NativeTarget;
      oldPathClosed: true;
      newAttemptId: AttemptId;
      newDeliveryId: DeliveryId;
    }
);
export type TodoEvent =
  | { kind: "answer"; answer: TodoAnswer; target: NativeTarget | null }
  | {
      kind: "sessionLost";
      sessionId: NativeSessionId;
      reason: string;
      messageFallback: MessageFallback | null;
    }
  | { kind: "delivery"; event: AnswerEvent };

function matchesTarget(a: NativeTarget, b: NativeTarget) {
  return a.sessionId === b.sessionId && a.requestId === b.requestId;
}
function matchesProof(a: AnswerProof, b: AnswerProof) {
  return matchesTarget(a, b);
}

/** The control plane records an answer before claiming delivery. Only a matching executor receipt confirms it. */
function transitionAnswerArrival(
  route: TodoRoute,
  state: AnswerArrival,
  event: Exclude<AnswerEvent, { kind: "redeliver" }>,
): TransitionResult<AnswerArrival> {
  if (route.kind === "message") return reject("routeUnavailable");
  switch (event.kind) {
    case "claim":
      return state.kind === "recorded" ? ok({ kind: "armed" }) : reject("invalidState");
    case "written":
      if (state.kind === "handed") return ok(state);
      return state.kind === "armed"
        ? ok({ kind: "handed", wroteAt: event.at })
        : reject("invalidState");
    case "received":
      if (!matchesTarget(route, event.proof)) return reject("wrongRequest");
      if (state.kind === "received")
        return matchesProof(state.proof, event.proof) ? ok(state) : reject("wrongDelivery");
      if (state.kind !== "armed" && state.kind !== "handed" && state.kind !== "uncertain")
        return reject("invalidState");
      return ok({ kind: "received", proof: event.proof });
    case "unknown":
      if (state.kind === "uncertain") return ok(state);
      return state.kind === "armed" || state.kind === "handed"
        ? ok({ kind: "uncertain", next: "inspectAnswer" })
        : reject("invalidState");
    case "refused":
      if (state.kind !== "armed" && state.kind !== "handed" && state.kind !== "uncertain")
        return reject("invalidState");
      return ok({ kind: "rejected", reason: event.reason });
    default:
      return unexpected(event);
  }
}

/** Two devices may answer the same request. The first accepted answer retains its author, time and content through recovery. */
export function transitionTodo(state: TodoState, event: TodoEvent): TransitionResult<TodoState> {
  switch (event.kind) {
    case "answer": {
      if (state.kind === "answered") return reject("alreadyAnswered");
      if (state.kind === "expired") return reject("routeUnavailable");
      const route = state.route;
      if (route.kind === "live") {
        if (!event.target) return reject("routeUnavailable");
        if (!matchesTarget(route, event.target)) return reject("wrongRequest");
      } else if (event.target) return reject("wrongRequest");
      if ((route.subject === "secret") !== (event.answer.content.kind === "secretReceipt"))
        return reject("wrongRequest");
      return ok({
        kind: "answered",
        route,
        answer: event.answer,
        arrival: route.kind === "message" ? { kind: "viaMessage" } : { kind: "recorded" },
        previousAttempts: [],
      });
    }
    case "sessionLost": {
      if (state.kind === "expired" || state.route.kind === "message") return ok(state);
      if (state.kind === "answered") {
        if (state.route.sessionId !== event.sessionId) return reject("wrongRequest");
        switch (state.arrival.kind) {
          case "viaMessage":
            return ok(state);
          case "recorded":
            return ok({
              ...state,
              arrival: { kind: "rejected", reason: "session-lost-before-delivery" },
            });
          case "armed":
          case "handed":
            return ok({ ...state, arrival: { kind: "uncertain", next: "inspectAnswer" } });
          case "uncertain":
          case "received":
          case "rejected":
            return ok(state);
          default:
            return unexpected(state.arrival);
        }
      }
      const route = state.route;
      if (route.sessionId !== event.sessionId) return reject("wrongRequest");
      const fallback = route.fallback,
        available = event.messageFallback;
      if (
        route.subject === "question" &&
        fallback.kind === "asMessage" &&
        available &&
        available.nodeId === fallback.nodeId &&
        available.questions.length === fallback.questions.length &&
        available.questions.every(
          (q, i) => q.id === fallback.questions[i] && q.text.trim().length > 0,
        )
      ) {
        return ok({
          kind: "open",
          route: {
            kind: "message",
            subject: "question",
            nodeId: fallback.nodeId,
            questions: fallback.questions,
          },
        });
      }
      return ok({ kind: "expired", reason: event.reason });
    }
    case "delivery": {
      if (state.kind !== "answered") return reject("invalidState");
      if (state.route.kind === "message") return reject("routeUnavailable");
      const report = event.event;
      if (report.kind === "redeliver") {
        const alreadyApplied =
          state.answer.attemptId === report.newAttemptId &&
          state.answer.deliveryId === report.newDeliveryId &&
          state.previousAttempts.some(
            (attempt) =>
              attempt.attemptId === report.attemptId && attempt.deliveryId === report.deliveryId,
          );
        if (alreadyApplied) return ok(state);
        if (report.attemptId !== state.answer.attemptId) return reject("wrongAttempt");
        if (report.deliveryId !== state.answer.deliveryId) return reject("wrongDelivery");
        if (
          state.arrival.kind !== "uncertain" ||
          state.route.kind !== "live" ||
          !matchesTarget(state.route, report.request) ||
          !report.oldPathClosed
        )
          return reject("routeUnavailable");
        if (
          report.newAttemptId === report.attemptId ||
          report.newDeliveryId === report.deliveryId ||
          state.previousAttempts.some(
            (attempt) =>
              attempt.attemptId === report.newAttemptId ||
              attempt.deliveryId === report.newDeliveryId,
          )
        )
          return reject("idConflict");
        return ok({
          ...state,
          previousAttempts: [
            ...state.previousAttempts,
            {
              attemptId: state.answer.attemptId,
              deliveryId: state.answer.deliveryId,
              arrival: state.arrival,
            },
          ],
          answer: {
            ...state.answer,
            attemptId: report.newAttemptId,
            deliveryId: report.newDeliveryId,
          },
          arrival: { kind: "recorded" },
        });
      }
      if (report.attemptId === state.answer.attemptId) {
        if (report.deliveryId !== state.answer.deliveryId) return reject("wrongDelivery");
        const result = transitionAnswerArrival(state.route, state.arrival, report);
        return result.kind === "rejected" ? result : ok({ ...state, arrival: result.value });
      }
      const prior = state.previousAttempts.find(
        (attempt) => attempt.attemptId === report.attemptId,
      );
      if (!prior) return reject("wrongAttempt");
      if (prior.deliveryId !== report.deliveryId) return reject("wrongDelivery");
      const result = transitionAnswerArrival(state.route, prior.arrival, report);
      if (result.kind === "rejected") return result;
      return ok({
        ...state,
        previousAttempts: state.previousAttempts.map((attempt) =>
          attempt === prior ? { ...attempt, arrival: result.value } : attempt,
        ),
      });
    }
    default:
      return unexpected(event);
  }
}
