import type { AdapterEventPayload, RoundEnd } from "@kraka/environment";
import type {
  AttemptId,
  DeliveryId,
  NativeItemId,
  NativeRootTurnId,
  NativeSessionId,
} from "@kraka/protocol";
import type { ClaudeCodeNativeFrame } from "./native";

export type ClaudeTurnState = {
  sessionId: NativeSessionId;
  attemptId: AttemptId;
  deliveryId: DeliveryId;
  input: { itemId: NativeItemId; root: NativeRootTurnId; text: string };
  received: boolean;
  answered: boolean;
  ended: boolean;
  blocks: ReadonlyMap<number, NativeItemId>;
  tools: ReadonlyMap<NativeItemId, { path: string | null }>;
};

function outcome(p: Extract<ClaudeCodeNativeFrame["payload"], { kind: "result" }>): RoundEnd {
  const nativeReason = p.terminal_reason ?? p.stop_reason ?? p.subtype;
  if (nativeReason === "aborted_streaming" || nativeReason === "aborted_tools")
    return { reason: "stopped", nativeReason };
  if (p.is_error || p.subtype.startsWith("error_"))
    return {
      reason: "failed",
      nativeReason,
      failure: { kind: "operationRejected", message: p.subtype },
    };
  if (p.subtype === "success" && ["completed", "end_turn", "stop_sequence"].includes(nativeReason))
    return { reason: "completed", nativeReason };
  return { reason: "unknown", nativeReason };
}
export function translateClaudeCodeFrame(frame: ClaudeCodeNativeFrame, state: ClaudeTurnState) {
  const events: AdapterEventPayload[] = [];
  if (frame.sessionId !== state.sessionId || state.ended) return { state, events };
  const p = frame.payload,
    { attemptId, input } = state;
  if (frame.firstAnswered !== null && frame.firstAnswered !== input.itemId)
    return { state: { ...state, answered: false, blocks: new Map() }, events };
  const answered = frame.firstAnswered === input.itemId;
  const echo =
    p.kind === "echo" && !p.synthetic && frame.itemId === input.itemId && p.text === input.text;
  let next = state;
  if (!state.received && (answered || echo)) {
    events.push({
      kind: "deliveryReceived",
      attemptId,
      deliveryId: state.deliveryId,
      receipt: { kind: "input", sessionId: state.sessionId, itemId: input.itemId },
    });
    next = { ...next, received: true };
  }
  if (answered && !state.answered) {
    next = { ...next, answered: true };
    events.push({ kind: "roundStarted", attemptId, nativeRootTurnId: input.root, at: null });
  }
  if (!next.answered) {
    if (p.kind === "result")
      events.push({
        kind: "sessionObservation",
        sourceId: frame.source,
        category: "turn",
        observedAt: frame.observedAt,
        redactedSummary: "Claude reported an unattributed terminal result",
      });
    return { state: next, events };
  }
  const relationship = { kind: "root", nativeRootTurnId: input.root } as const;
  switch (p.kind) {
    case "block": {
      const blocks = new Map(next.blocks);
      if (p.value?.kind === "text" || p.value?.kind === "thinking")
        blocks.set(p.index, frame.itemId);
      else blocks.delete(p.index);
      next = { ...next, blocks };
      break;
    }
    case "delta": {
      const itemId = next.blocks.get(p.index);
      if (itemId)
        events.push({
          kind: "contentDelta",
          attemptId,
          itemId,
          role: p.role,
          text: p.text,
          finalText: null,
        });
      break;
    }
    case "assistant": {
      const tools = new Map(next.tools);
      for (const [index, b] of p.blocks.entries()) {
        if (b?.kind === "text" || b?.kind === "thinking") {
          events.push({
            kind: "contentDelta",
            attemptId,
            itemId: next.blocks.get(index) ?? p.itemIds[index]!,
            role: b.kind === "text" ? "assistant" : "reasoning",
            text: "",
            finalText: b.value,
          });
        } else if (b?.kind === "tool" && !tools.has(b.id)) {
          const path =
            b.name === "Edit" &&
            b.input &&
            typeof b.input === "object" &&
            "file_path" in b.input &&
            typeof b.input.file_path === "string"
              ? b.input.file_path
              : null;
          tools.set(b.id, { path });
          events.push({
            kind: "toolActivity",
            attemptId,
            callId: b.id,
            phase: "started",
            relationship,
            input: b.input,
            output: null,
          });
        }
      }
      next = { ...next, tools, blocks: new Map() };
      break;
    }
    case "progress":
      if (next.tools.has(p.id))
        events.push({
          kind: "toolActivity",
          attemptId,
          callId: p.id,
          phase: "progress",
          relationship,
          input: null,
          output: null,
        });
      break;
    case "outputs": {
      for (const b of p.blocks) {
        if (b?.kind !== "output" || !next.tools.has(b.id)) continue;
        const path = next.tools.get(b.id)?.path;
        events.push({
          kind: "toolActivity",
          attemptId,
          callId: b.id,
          phase: "ended",
          relationship,
          input: null,
          output: {
            text: typeof b.value === "string" ? b.value : JSON.stringify(b.value),
            status: b.error ? "failed" : "completed",
            result: p.structured,
          },
          ...(path && !b.error
            ? { changes: [{ path, change: "modified", destination: null, patch: null }] }
            : {}),
        });
      }
      break;
    }
    case "result":
      events.push({
        kind: "roundEnded",
        attemptId,
        nativeRootTurnId: input.root,
        endedAt: frame.observedAt,
        endTimeEvidence: {
          source: "environmentObserved",
          executorEndedAt: null,
          environmentObservedAt: frame.observedAt,
        },
        outcome: outcome(p),
      });
      next = { ...next, ended: true };
      break;
  }
  return { state: next, events };
}
