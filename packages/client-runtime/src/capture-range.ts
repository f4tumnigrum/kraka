import type { CheckpointCapture, DiffRequest, Round } from "@kraka/protocol";

type RoundRequest = Extract<DiffRequest, { kind: "round" }>;

/** Supply the thread's effective rounds in chronological order, including older history pages. */
export function cumulativeRoundRange(
  selected: RoundRequest,
  rounds: readonly Round[],
  captures: readonly CheckpointCapture[],
): Extract<DiffRequest, { kind: "roundRange" }> | null {
  const byId = new Map(captures.map((c) => [c.id, c]));
  let first: CheckpointCapture["id"] | undefined;
  for (const round of rounds) {
    const { phase, attemptId } = round.attempt;
    if (round.threadId !== selected.threadId || phase.kind !== "finished") continue;
    const c = byId.get(phase.captureId);
    const ready = c?.result;
    const matches =
      c?.roundId === round.id &&
      c.attemptId === attemptId &&
      ready?.kind === "ready" &&
      !!ready.comparison &&
      ("worktreeId" in selected
        ? "worktreeId" in ready && ready.worktreeId === selected.worktreeId
        : "directoryId" in ready &&
          ready.directoryId === selected.directoryId &&
          ready.generation === selected.generation);
    if (matches) first ??= phase.captureId;
    if (phase.captureId === selected.captureId) {
      if (!matches || !first) return null;
      const { captureId, ...address } = selected;
      return { ...address, kind: "roundRange", fromCaptureId: first, toCaptureId: captureId };
    }
  }
  return null;
}
