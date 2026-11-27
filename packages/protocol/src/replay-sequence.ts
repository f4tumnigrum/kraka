import type { AttemptId, RoundId } from "./ids";
import type { ReplayTurnUpdate } from "./replay";

const stages = [
  "round.started",
  "tool.started",
  "tool.output",
  "tool.ended",
  "assistant.delta",
  "assistant.delta",
  "assistant.final",
  "round.ended",
] as const;

/** Validate the fixed basic-turn layout and the native relationships across messages. */
export function validateReplayUpdate(
  run: { roundId: RoundId; attemptId: AttemptId },
  previous: readonly ReplayTurnUpdate[],
  update: ReplayTurnUpdate,
): void {
  if (
    update.roundId !== run.roundId ||
    update.attemptId !== run.attemptId ||
    update.kind !== stages[previous.length]
  )
    throw new Error("Unexpected replay update or attempt");
  const [start, tool, output, , first, second] = previous;
  if ("callId" in update && tool?.kind === "tool.started" && update.callId !== tool.callId)
    throw new Error("Tool call changed");
  if (
    update.kind === "tool.ended" &&
    output?.kind === "tool.output" &&
    output.text !== update.output
  )
    throw new Error("Tool output changed");
  if ("itemId" in update && first?.kind === "assistant.delta" && update.itemId !== first.itemId)
    throw new Error("Assistant item changed");
  if (
    update.kind === "assistant.final" &&
    first?.kind === "assistant.delta" &&
    second?.kind === "assistant.delta" &&
    update.text !== first.text + second.text
  )
    throw new Error("Assistant final differs from streamed text");
  if (
    update.kind === "round.ended" &&
    start?.kind === "round.started" &&
    (update.nativeRootTurnId !== start.nativeRootTurnId || update.endedAt < start.startedAt)
  )
    throw new Error("Invalid native end");
}
