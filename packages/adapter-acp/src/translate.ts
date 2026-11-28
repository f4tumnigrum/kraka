import type { AdapterEventPayload, RoundEnd } from "@kraka/environment";
import type {
  NativeSessionId,
  NativeRootTurnId,
  NativeItemId,
  DeliveryId,
  AttemptId,
} from "@kraka/protocol";

export type AcpTurnState = {
  sessionId: NativeSessionId;
  root: NativeRootTurnId;
  itemId: NativeItemId;
  attemptId: AttemptId;
  deliveryId: DeliveryId;
  cancelled: boolean;
  ended: boolean;
};
export type PromptEnd =
  | { stopReason: string; observedAt: number }
  | { code: number; observedAt: number; safeMessage: string };
export function translateAcpFrame(
  frame: PromptEnd,
  state: AcpTurnState,
): { state: AcpTurnState; events: AdapterEventPayload[] } {
  if (state.ended) return { state, events: [] };
  const { sessionId, itemId, attemptId, deliveryId } = state;
  let outcome: RoundEnd;
  if ("code" in frame) {
    outcome =
      frame.code === -32800 && state.cancelled
        ? { reason: "stopped", nativeReason: "-32800" }
        : {
            reason: "failed",
            nativeReason: String(frame.code),
            failure: {
              kind: frame.code === -32000 ? "authentication" : "operationRejected",
              message: frame.safeMessage,
            },
          };
  } else {
    const reason = frame.stopReason;
    if (reason === "end_turn" || reason === "cancelled")
      outcome = { reason: reason === "end_turn" ? "completed" : "stopped", nativeReason: reason };
    else if (["max_tokens", "max_turn_requests", "refusal"].includes(reason))
      outcome = {
        reason: "failed",
        nativeReason: reason,
        failure: { kind: "operationRejected", message: reason },
      };
    else outcome = { reason: "unknown", nativeReason: reason };
  }
  return {
    state: { ...state, ended: true },
    events: [
      {
        kind: "deliveryReceived",
        attemptId,
        deliveryId,
        receipt: { kind: "input", sessionId, itemId },
      },
      {
        kind: "roundEnded",
        attemptId,
        nativeRootTurnId: state.root,
        endedAt: frame.observedAt,
        endTimeEvidence: {
          source: "environmentObserved",
          executorEndedAt: null,
          environmentObservedAt: frame.observedAt,
        },
        outcome,
      },
    ],
  };
}
