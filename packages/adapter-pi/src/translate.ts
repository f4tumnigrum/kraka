import type { AdapterEventPayload, AdapterSessionBinding, RoundEnd } from "@kraka/environment";
import type { AttemptId, NativeItemId, NativeRootTurnId } from "@kraka/protocol";
import type { PiNativeFrame, PiPromptDisposition, UiRequest } from "./native";

type Root = { id: NativeRootTurnId; attemptId: AttemptId; session: AdapterSessionBinding<"pi"> };
type Settled = Extract<PiNativeFrame["event"], { type: "agent_settled" }>;
export function observePiSettlement(input: {
  binding: AdapterSessionBinding<"pi">;
  attemptId: AttemptId;
  promptDisposition: PiPromptDisposition;
  activeRoot: Root | null;
  lastAssistantReason: string | null;
  settledFrame: Settled;
  observedAt: number;
}): Extract<AdapterEventPayload, { kind: "roundEnded" }> | { kind: "unresolved" } {
  const { binding, activeRoot: root, lastAssistantReason: reason, observedAt } = input;
  if (
    !root ||
    input.promptDisposition === "handled" ||
    input.attemptId !== root.attemptId ||
    !binding.nativeSessionId ||
    binding.nativeSessionId !== root.session.nativeSessionId ||
    binding.instanceId !== root.session.instanceId ||
    binding.epoch !== root.session.epoch
  )
    return { kind: "unresolved" };
  let outcome: RoundEnd;
  if (input.settledFrame.aborted) outcome = { reason: "stopped", nativeReason: reason };
  else if (reason === "stop" || reason === "length")
    outcome = { reason: "completed", nativeReason: reason };
  else if (reason === "error")
    outcome = {
      reason: "failed",
      nativeReason: reason,
      failure: { kind: "unknown", message: "Pi reported an assistant error" },
    };
  else outcome = { reason: "unknown", nativeReason: reason };
  return {
    kind: "roundEnded",
    attemptId: root.attemptId,
    nativeRootTurnId: root.id,
    endedAt: observedAt,
    endTimeEvidence: {
      source: "environmentObserved",
      environmentObservedAt: observedAt,
      executorEndedAt: null,
    },
    outcome,
  };
}
export type Prompt = {
  attemptId: AttemptId;
  rootId: NativeRootTurnId;
  disposition: "queued" | "started";
  text: string;
  queue: "unseen" | "present" | "removed" | "picked" | "ambiguous";
  beganAt: number | null;
};
export type PiState = {
  binding: AdapterSessionBinding<"pi">;
  prompt: Prompt | null;
  root: Root | null;
  lastAssistantReason: string | null;
  messagePosition: number | null;
  approvalTitle: string;
  displayId: (message: number, block: number) => NativeItemId;
};
export function piRequest(
  req: UiRequest,
  attemptId: AttemptId,
  approvalTitle: string,
): Extract<AdapterEventPayload, { kind: "requestOpened" }> {
  const base = {
    kind: "requestOpened",
    attemptId,
    requestId: req.id,
    recovery: "liveOnly",
  } as const;
  if (
    req.method === "confirm" &&
    (req.title === `${approvalTitle} command` || req.title === `${approvalTitle} file`)
  ) {
    const tool = req.title === `${approvalTitle} file` ? "file" : "command";
    const choices = ["allow", "deny"].map((decision) => ({
      key: decision,
      scope: "once" as const,
      allowsEdit: false,
    }));
    return {
      ...base,
      body: { kind: "approval", tool, choices },
      approval: {
        permission: tool === "file" ? "workspace.change" : "term.input",
        choices: [
          { kind: "approval", scope: "once", choiceKey: "allow", decision: "allow" },
          { kind: "approval", scope: "once", choiceKey: "deny", decision: "deny" },
        ],
      },
    };
  }
  return {
    ...base,
    body: {
      kind: "question",
      questions: [
        {
          key: req.id,
          text: [req.title, req.message].filter(Boolean).join("\n"),
          choices:
            req.method === "select"
              ? (req.options ?? [])
              : req.method === "confirm"
                ? ["yes", "no"]
                : [],
        },
      ],
    },
  };
}

export function translatePiFrame(
  frame: PiNativeFrame,
  previous: PiState,
): { state: PiState; events: AdapterEventPayload[] } {
  const { event, position, observedAt } = frame;
  const state = { ...previous };
  const events: AdapterEventPayload[] = [];
  const prompt = previous.prompt;
  if (prompt && !state.root) {
    let next = { ...prompt };
    if (event.type === "agent_start" && next.beganAt === null) next.beganAt = observedAt;
    if (prompt.disposition === "queued") {
      if (event.type === "queue_update") {
        const queued = [...event.steering, ...event.followUp];
        if (queued.length === 1 && queued[0] === prompt.text && prompt.queue === "unseen")
          next.queue = "present";
        else if (!queued.length && prompt.queue === "present") next.queue = "removed";
        else if (
          queued.length &&
          !(prompt.queue === "present" && queued.length === 1 && queued[0] === prompt.text)
        )
          next.queue = "ambiguous";
      }
      if (
        event.type === "message_start" &&
        event.message.role === "user" &&
        prompt.queue === "removed"
      ) {
        const content = event.message.content;
        next.queue =
          content === prompt.text ||
          (Array.isArray(content) &&
            content.length === 1 &&
            content[0]?.type === "text" &&
            content[0].text === prompt.text)
            ? "picked"
            : "ambiguous";
      }
    }
    state.prompt = next;
    if (next.beganAt !== null && (next.disposition === "started" || next.queue === "picked")) {
      state.root = { id: next.rootId, attemptId: next.attemptId, session: state.binding };
      events.push({
        kind: "roundStarted",
        attemptId: next.attemptId,
        nativeRootTurnId: next.rootId,
        at: next.beganAt,
      });
    }
  }
  const root = state.root;
  if (
    event.type === "tool_execution_start" ||
    event.type === "tool_execution_update" ||
    event.type === "tool_execution_end"
  ) {
    events.push({
      kind: "sessionObservation",
      sourceId: event.toolCallId,
      category: "toolActivity",
      observedAt,
      redactedSummary:
        event.type === "tool_execution_start"
          ? "Pi reported a tool start."
          : event.type === "tool_execution_update"
            ? "Pi reported tool progress."
            : "Pi reported a tool result.",
    });
  } else if (event.type === "extension_ui_request") {
    if (root) events.push(piRequest(event, root.attemptId, state.approvalTitle));
    else
      events.push({
        kind: "sessionObservation",
        sourceId: event.id,
        category: "request",
        observedAt,
        redactedSummary: "Pi reported an unassigned UI request.",
      });
  } else if (root && prompt) {
    const attemptId = root.attemptId;
    if (event.type === "auto_retry_start") state.lastAssistantReason = null;
    if (event.type === "message_start" && event.message.role === "assistant") {
      state.messagePosition = position;
      state.lastAssistantReason = null;
    }
    if (event.type === "message_update" && state.messagePosition !== null) {
      const block = event.assistantMessageEvent;
      if (
        block.contentIndex !== undefined &&
        ["text_delta", "thinking_delta", "text_end", "thinking_end"].includes(block.type)
      ) {
        const final = block.type.endsWith("_end");
        if ((final ? block.content : block.delta) !== undefined)
          events.push({
            kind: "contentDelta",
            attemptId,
            itemId: state.displayId(state.messagePosition, block.contentIndex),
            role: block.type.startsWith("thinking") ? "reasoning" : "assistant",
            text: final ? "" : (block.delta ?? ""),
            finalText: final ? (block.content ?? null) : null,
          });
      }
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      state.lastAssistantReason = event.message.stopReason ?? null;
      const content = event.message.content;
      if (Array.isArray(content))
        content.forEach((b, i) => {
          const value = b.type === "text" ? b.text : b.type === "thinking" ? b.thinking : undefined;
          if (value !== undefined)
            events.push({
              kind: "contentDelta",
              attemptId,
              itemId: state.displayId(state.messagePosition ?? position, i),
              role: b.type === "thinking" ? "reasoning" : "assistant",
              text: "",
              finalText: value,
            });
        });
      state.messagePosition = null;
    }
    if (event.type === "agent_settled") {
      const ended = observePiSettlement({
        binding: state.binding,
        attemptId,
        promptDisposition: prompt.disposition,
        activeRoot: root,
        lastAssistantReason: state.lastAssistantReason,
        settledFrame: event,
        observedAt,
      });
      if (ended.kind === "roundEnded") events.push(ended);
      state.root = null;
      state.prompt = null;
      state.lastAssistantReason = null;
      state.messagePosition = null;
    }
  }
  return { events, state };
}
