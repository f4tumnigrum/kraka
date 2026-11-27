import type {
  ForgeHistory,
  ForgeHistoryEvent,
  ForgeHistorySource,
  ForgeWatch,
} from "@kraka/protocol";
import { sameForgeRepository, type ForgeScope } from "./forge";

export type HistoryEvidence =
  | { kind: "currentOnly" }
  | { kind: "interrupted"; reason: string }
  | { kind: "history"; retainedFrom: number; retainedThrough: number; nextPage: string | null };
/** Exhausting a current-state listing does not establish historical coverage. Keep known events even when there is a gap. */
export function finishHistoryRead(
  batch: Omit<ForgeHistory, "coverage">,
  evidence: HistoryEvidence,
): ForgeHistory {
  if (evidence.kind === "currentOnly")
    return { ...batch, coverage: { kind: "gap", reason: "currentStateOnly" } };
  if (evidence.kind === "interrupted")
    return { ...batch, coverage: { kind: "gap", reason: evidence.reason } };
  if (evidence.nextPage !== null)
    return { ...batch, coverage: { kind: "gap", reason: "incompletePages" } };
  if (evidence.retainedFrom > batch.from || evidence.retainedThrough < batch.through)
    return { ...batch, coverage: { kind: "gap", reason: "incompleteRetention" } };
  return { ...batch, coverage: { kind: "complete" } };
}
export type HistoryBoundary = { through: number; idsAtBoundary: readonly string[] };
export type ForgeObservation = {
  watch: ForgeWatch;
  streams: Readonly<Record<ForgeHistorySource, HistoryBoundary>>;
  seen: ReadonlySet<string>;
  gaps: Readonly<
    Partial<Record<ForgeHistorySource, { from: number; through: number; reason: string }>>
  >;
};
export function startForgeWatch(
  scope: Pick<ForgeScope, "threadId" | "repository">,
  watch: ForgeWatch,
  from: number,
):
  | { kind: "ok"; observation: ForgeObservation }
  | { kind: "rejected"; reason: "crossRepository" | "wrongWatch" } {
  if (!sameForgeRepository(scope.repository, watch.pull.repository))
    return { kind: "rejected", reason: "crossRepository" };
  if (scope.threadId !== watch.threadId) return { kind: "rejected", reason: "wrongWatch" };
  const start = { through: from, idsAtBoundary: [] };
  return {
    kind: "ok",
    observation: {
      watch,
      streams: { timeline: start, checks: start, discussion: start },
      seen: new Set(),
      gaps: {},
    },
  };
}
function sourceFor(event: ForgeHistoryEvent): ForgeHistorySource {
  switch (event.kind) {
    case "check":
      return "checks";
    case "comment":
      return "discussion";
    case "review":
    case "pullRequest":
      return "timeline";
  }
}
export type HistoryNotice =
  | { kind: "event"; key: string; event: ForgeHistoryEvent }
  | { kind: "gap"; key: string; from: number; through: number; reason: string };
export type HistoryUpdate =
  | { kind: "rejected"; reason: "wrongWatch" | "invalidInterval" }
  | { kind: "ok"; observation: ForgeObservation; notices: readonly HistoryNotice[] };
/** A complete batch certifies all pages of this source over the interval. A last page or an unchanged sample alone cannot do that.
 * Persist the returned witnesses, boundaries, gaps and thread notices together.
 */
export function applyForgeHistory(old: ForgeObservation, batch: ForgeHistory): HistoryUpdate {
  const a = old.watch,
    b = batch.watch;
  if (
    a.generation !== b.generation ||
    a.threadId !== b.threadId ||
    a.pull.number !== b.pull.number ||
    !sameForgeRepository(a.pull.repository, b.pull.repository)
  )
    return { kind: "rejected", reason: "wrongWatch" };
  const boundary = old.streams[batch.source];
  if (
    batch.through < batch.from ||
    batch.from > boundary.through ||
    batch.events.some(
      (e) => sourceFor(e) !== batch.source || e.at < batch.from || e.at > batch.through,
    )
  )
    return { kind: "rejected", reason: "invalidInterval" };
  if (batch.through < boundary.through) return { kind: "ok", observation: old, notices: [] };
  const key = (...parts: (number | string)[]) =>
    JSON.stringify([
      a.threadId,
      a.pull.repository.host,
      a.pull.repository.id,
      a.pull.number,
      a.generation,
      batch.source,
      ...parts,
    ]);
  const seen = new Set(old.seen),
    notices: HistoryNotice[] = [];
  const edge = new Set(batch.through === boundary.through ? boundary.idsAtBoundary : []);
  for (const event of [...batch.events].sort((x, y) => x.at - y.at)) {
    const id = key("event", event.id, event.version);
    if (event.at === batch.through) edge.add(id);
    if (seen.has(id)) continue;
    seen.add(id);
    notices.push({ kind: "event", key: id, event });
  }
  const gaps = { ...old.gaps };
  if (batch.coverage.kind === "gap") {
    const from = boundary.through;
    if (batch.through === from) return { kind: "ok", observation: { ...old, seen }, notices };
    const id = key("gap", from, batch.through);
    if (!seen.has(id)) {
      seen.add(id);
      notices.push({
        kind: "gap",
        key: id,
        from,
        through: batch.through,
        reason: batch.coverage.reason,
      });
    }
    const previous = gaps[batch.source];
    if (!previous || batch.through >= previous.through)
      gaps[batch.source] = {
        from,
        through: batch.through,
        reason: batch.coverage.reason,
      };
    return { kind: "ok", observation: { ...old, seen, gaps }, notices };
  }
  const gap = gaps[batch.source];
  if (gap && batch.through >= gap.through) delete gaps[batch.source];
  else if (gap && batch.through > gap.from) gaps[batch.source] = { ...gap, from: batch.through };
  return {
    kind: "ok",
    observation: {
      ...old,
      seen,
      gaps,
      streams: {
        ...old.streams,
        [batch.source]: { through: batch.through, idsAtBoundary: [...edge].sort() },
      },
    },
    notices,
  };
}
