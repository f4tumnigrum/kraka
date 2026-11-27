import type {
  AdapterNormalizerState,
  AdapterEventPayload,
  NormalizedEvents,
} from "@kraka/environment";
import type { ReplayFrame } from "./native";

export function translateReplayFrame(
  frame: ReplayFrame,
  state: AdapterNormalizerState<"replay">,
): NormalizedEvents<"replay"> {
  if (frame.kind === "internal") return { state, events: [] };
  const delivery = state.pendingDeliveries.get(frame.requestId);
  if (!delivery) throw new Error("No delivery bound to recorded request");
  const { attemptId } = delivery;
  let payload: AdapterEventPayload;
  switch (frame.kind) {
    case "start":
      payload = { kind: "roundStarted", attemptId, nativeRootTurnId: frame.root, at: frame.at };
      break;
    case "toolStart":
      payload = {
        kind: "toolActivity",
        attemptId,
        callId: frame.id,
        phase: "started",
        input: { command: frame.command },
        output: null,
      };
      break;
    case "toolDelta":
      payload = {
        kind: "toolActivity",
        attemptId,
        callId: frame.id,
        phase: "progress",
        input: null,
        output: { text: frame.text },
      };
      break;
    case "toolEnd":
      payload = {
        kind: "toolActivity",
        attemptId,
        callId: frame.id,
        phase: "ended",
        input: null,
        output: { text: frame.text, exitCode: frame.exitCode },
      };
      break;
    case "delta":
    case "final":
      payload = {
        kind: "contentDelta",
        attemptId,
        itemId: frame.id,
        role: "assistant",
        text: frame.kind === "delta" ? frame.text : "",
        finalText: frame.kind === "final" ? frame.text : null,
      };
      break;
    case "end":
      payload = {
        kind: "roundEnded",
        attemptId,
        nativeRootTurnId: frame.root,
        endedAt: frame.at,
        endTimeEvidence: {
          source: "executorReported",
          executorEndedAt: frame.at,
          environmentObservedAt: null,
        },
        outcome: { reason: "completed", nativeReason: null },
      };
      break;
  }
  return { state, events: [payload] };
}
