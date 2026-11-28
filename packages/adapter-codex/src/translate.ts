import type { AdapterEventPayload, RoundEnd } from "@kraka/environment";
import type { AttemptId, DeliveryId, NativeRootTurnId, NativeSessionId } from "@kraka/protocol";
import type { CodexNativeFrame } from "./native";
export type CodexTurnState = {
  sessionId: NativeSessionId;
  root: NativeRootTurnId;
  attemptId: AttemptId;
  deliveryId: DeliveryId;
  startedAt: number | null;
  ended: boolean;
  received: boolean;
  finals: ReadonlySet<string>;
  tools: ReadonlySet<string>;
  terminal: { observedAt: number | null; outcome: RoundEnd } | null;
};
function milliseconds(raw: unknown) {
  if (typeof raw !== "number") return null;
  const ms = raw * 1000;
  return Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
}
export function translateCodexFrame(
  frame: CodexNativeFrame,
  state: CodexTurnState,
  observedAt: number | null = null,
) {
  const events: AdapterEventPayload[] = [];
  let next = state;
  let lookup = false;
  const { attemptId, root } = state;
  if (frame.threadId !== state.sessionId || state.ended) return { state, events, lookup };
  if (frame.method === "serverRequest/resolved" || frame.method === "callback")
    return { state, events, lookup };
  if ("turn" in frame) {
    const { turn } = frame;
    if (
      (frame.method === "turn/completed" && turn.status === "inProgress") ||
      turn.id !== root ||
      (turn.rootTurnId != null && turn.rootTurnId !== root)
    )
      return { state, events, lookup };
    if (frame.method === "turn/started") {
      const at = milliseconds(turn.startedAt);
      if (at !== null && state.startedAt === null && !state.terminal) {
        next = { ...state, startedAt: at };
        events.push({ kind: "roundStarted", attemptId, nativeRootTurnId: root, at });
      }
    } else {
      const terminal = state.terminal ?? { observedAt, outcome: turn.outcome };
      const endedAt = milliseconds(turn.completedAt);
      if (endedAt === null || endedAt < (state.startedAt ?? 0)) {
        lookup = state.terminal === null;
        next = { ...state, terminal };
      } else {
        next = { ...state, terminal, ended: true };
        events.push({
          kind: "roundEnded",
          attemptId,
          nativeRootTurnId: root,
          endedAt,
          outcome: terminal.outcome,
          endTimeEvidence: {
            source: "executorReported",
            executorEndedAt: endedAt,
            environmentObservedAt: terminal.observedAt,
          },
        });
      }
    }
  } else if (frame.turnId === root && !state.terminal) {
    if ("delta" in frame) {
      if (frame.method === "item/agentMessage/delta" && !state.finals.has(frame.itemId))
        events.push({
          kind: "contentDelta",
          attemptId,
          itemId: frame.itemId,
          role: "assistant",
          text: frame.delta,
          finalText: null,
        });
      if (frame.method === "item/commandExecution/outputDelta" && state.tools.has(frame.itemId))
        events.push({
          kind: "toolActivity",
          attemptId,
          callId: frame.itemId,
          relationship: { kind: "root", nativeRootTurnId: root },
          phase: "progress",
          input: null,
          output: { text: frame.delta },
        });
    } else {
      const { item } = frame;
      if (item.type === "userMessage" && item.clientId === state.deliveryId && !state.received) {
        next = { ...state, received: true };
        events.push({
          kind: "deliveryReceived",
          attemptId,
          deliveryId: state.deliveryId,
          receipt: { kind: "input", sessionId: state.sessionId, itemId: item.id },
        });
      }
      if (
        item.type === "agentMessage" &&
        frame.method === "item/completed" &&
        !state.finals.has(item.id)
      ) {
        next = { ...state, finals: new Set(state.finals).add(item.id) };
        events.push({
          kind: "contentDelta",
          attemptId,
          itemId: item.id,
          role: "assistant",
          text: "",
          finalText: item.text,
        });
      }
      if (item.type === "fileChange" && frame.method === "item/completed") {
        for (const change of item.changes) {
          const destination = change.kind.type === "update" ? (change.kind.movePath ?? null) : null;
          events.push({
            kind: "fileChanged",
            attemptId,
            path: change.path,
            destination,
            patch: change.diff,
            change:
              change.kind.type === "add"
                ? "created"
                : change.kind.type === "delete"
                  ? "deleted"
                  : destination
                    ? "moved"
                    : "modified",
          });
        }
      }
      if (item.type === "commandExecution") {
        const start = frame.method === "item/started",
          tools = new Set(state.tools);
        if (start !== tools.has(item.id)) {
          if (start) tools.add(item.id);
          else tools.delete(item.id);
          next = { ...state, tools };
          events.push({
            kind: "toolActivity",
            attemptId,
            callId: item.id,
            relationship: { kind: "root", nativeRootTurnId: root },
            phase: start ? "started" : "ended",
            input: start ? { command: item.command, ...(item.cwd ? { cwd: item.cwd } : {}) } : null,
            output: start
              ? null
              : {
                  text: item.aggregatedOutput,
                  exitCode: item.exitCode,
                  status: item.status ?? null,
                  truncated: item.truncated ?? false,
                },
          });
        }
      }
    }
  }
  return { state: next, events, lookup };
}
