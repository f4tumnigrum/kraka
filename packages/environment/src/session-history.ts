import type {
  HandoffEntry,
  HistoryCoverage,
  InputContent,
  SessionTransitionPreview,
} from "@kraka/protocol";
import { comparePositions } from "@kraka/protocol";
import type { FirstSendStore } from "./first-send-store";
import { orderRows, visibleThreadRows } from "./thread-pass";
import type { LocalActor } from "./command-receipts";
type Source = NonNullable<SessionTransitionPreview["source"]>;

export function historyAt(store: FirstSendStore, actor: LocalActor, source: Source) {
  const canRead = (threadId: Source["threadId"]) =>
    actor.allows("thread.view", { kind: "thread", threadId });
  if (
    actor.environmentId !== store.writer.environmentId ||
    source.environmentId !== actor.environmentId ||
    !canRead(source.threadId)
  )
    return null;
  const scope = {
    threadId: source.threadId,
    environmentId: actor.environmentId,
    canRead,
    timelineItems: false,
    protocolMinor: 1,
  };
  const view = store.sync.read(scope, "session-transition");
  const rows = visibleThreadRows(scope, view).rows;
  let point = source;
  const visited = new Set<string>();
  const entries: HandoffEntry[] = [];
  let coverage: HistoryCoverage = { coverage: "complete", missingSources: [], omittedItems: 0 };
  const segments: HandoffEntry[][] = [];
  while (true) {
    if (!canRead(point.threadId)) return null;
    const local = rows.filter((item) => item.source === point.threadId);
    const thread = view.rows.find(
      (item) => item.source === point.threadId && item.row.objectType === "thread",
    )?.row;
    const round = local.find(
      (item) => item.row.objectType === "round" && item.row.value.id === point.roundId,
    );
    if (visited.has(point.threadId) || thread?.objectType !== "thread" || !round) {
      if (!visited.size) return null;
      const missing = visited.has(point.threadId)
        ? { kind: "cycle" as const, ...point }
        : thread?.objectType !== "thread"
          ? {
              kind: "missingThread" as const,
              threadId: point.threadId,
              environmentId: point.environmentId,
            }
          : { kind: "missingRound" as const, ...point };
      coverage = { coverage: "partial", missingSources: [missing], omittedItems: 0 };
      break;
    }
    visited.add(point.threadId);
    const rounds = new Set(
      local
        .filter(
          (item) =>
            item.row.objectType === "round" && comparePositions(item.created, round.created) <= 0,
        )
        .map((item) => item.row.value.id),
    );
    const cutoff = local
      .filter((item) => item.round === point.roundId)
      .reduce(
        (end, item) => (comparePositions(item.created, end) > 0 ? item.created : end),
        round.created,
      );
    segments.push(
      local.sort(orderRows).flatMap(({ row, created }) =>
        row.objectType === "message" &&
        (row.value.roundId ? rounds.has(row.value.roundId) : comparePositions(created, cutoff) <= 0)
          ? [
              {
                id: row.value.id,
                version: row.value.version,
                role:
                  row.value.author.kind === "person" ? ("user" as const) : ("assistant" as const),
                text: row.value.text,
              },
            ]
          : [],
      ),
    );
    if (thread.value.lineage.kind !== "fork") break;
    point = {
      ...point,
      threadId: thread.value.lineage.parentThreadId,
      roundId: thread.value.lineage.sourceRoundId,
    };
  }
  for (const segment of segments.reverse()) for (const item of segment) entries.push(item);
  return { entries, coverage };
}
export function selectHandoff(
  entries: readonly HandoffEntry[],
  input: InputContent,
  catalogVersion: number,
  capacity: number | null,
  allowance = 16000,
) {
  const windowTokens = capacity ?? 128000;
  const workTokens = Math.max(16000, Math.ceil(windowTokens / 4));
  const inputTokens =
    Math.ceil(Buffer.byteLength(input.text) / 4) +
    input.attachments.reduce((sum, a) => sum + (a.kind === "image" ? 8192 : 4096), 0);
  const allowanceTokens = Math.min(64000, Math.max(1024, allowance));
  const available = windowTokens - workTokens - inputTokens;
  const budget = {
    catalogVersion,
    windowTokens,
    windowSource: capacity === null ? ("estimated" as const) : ("reported" as const),
    workTokens,
    inputTokens,
    allowanceTokens,
    historyBytes: 64000,
    historyTokens: Math.max(0, Math.min(allowanceTokens, available)),
  };
  const selected = new Set<HandoffEntry>();
  const newest = [...entries].reverse();
  const order = [
    newest.find((e) => e.role === "user"),
    newest.find((e) => e.role === "assistant"),
    entries.find((e) => e.role === "user"),
    ...newest,
  ];
  let bytes = 2,
    tokens = 0;
  for (const entry of order) {
    if (!entry || selected.has(entry)) continue;
    const cost = Buffer.byteLength(JSON.stringify(entry)) + (selected.size ? 1 : 0);
    const tokenCost = Math.ceil(cost / 4);
    if (bytes + cost > budget.historyBytes || tokens + tokenCost > budget.historyTokens) continue;
    selected.add(entry);
    bytes += cost;
    tokens += tokenCost;
  }
  return {
    fits: available >= 0,
    budget,
    entries: entries.filter((e) => selected.has(e)),
    omittedItems: entries.length - selected.size,
  };
}
