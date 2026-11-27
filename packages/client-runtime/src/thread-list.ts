import { sameHead, comparePositions, type SyncCursor, type ThreadSummary } from "@kraka/protocol";
import { interpretAttention } from "./attention";
import { scopeKey, type ThreadCache, type ThreadFrameState } from "./thread-pass";
function order(a: ThreadSummary, b: ThreadSummary) {
  const x = a.lifecycle.state,
    y = b.lifecycle.state;
  if (x.kind !== y.kind) return x.kind === "active" ? -1 : 1;
  if (x.kind === "settled" && y.kind === "settled" && x.at !== y.at) return y.at - x.at;
  if (x.kind === "active" && y.kind === "active") {
    if ((x.pinnedAt === null) !== (y.pinnedAt === null)) return x.pinnedAt === null ? 1 : -1;
    const pinned = x.pinnedAt !== null;
    const u = pinned ? x.pinPosition : x.manualPosition,
      v = pinned ? y.pinPosition : y.manualPosition;
    if (u !== v)
      return u === null
        ? pinned
          ? 1
          : -1
        : v === null
          ? pinned
            ? -1
            : 1
          : comparePositions(u, v);
    const time = pinned ? b.createdAt - a.createdAt : b.lastActivityAt - a.lastActivityAt;
    if (time) return time;
  }
  const left = Array.from(a.threadId),
    right = Array.from(b.threadId);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const diff = left[i]!.codePointAt(0)! - right[i]!.codePointAt(0)!;
    if (diff) return diff;
  }
  return left.length - right.length;
}
export function installedList(
  cache: ThreadCache,
  state: Pick<ThreadFrameState, "installed" | "status">,
) {
  const head: SyncCursor | null = state.installed;
  const scope = head && cache.scopes[scopeKey(head)];
  if (!scope?.facts || !scope.listRows || !scope.counts || !head || !sameHead(scope.cursor, head))
    return null;
  const rows = Object.values(scope.listRows)
    .sort(order)
    .map((summary) => {
      const facts = scope.facts![JSON.stringify(summary.threadId)]!;
      const { first, causes, needsHuman, open } = interpretAttention(facts);
      return {
        summary,
        state: first.kind,
        causes,
        needsHuman,
        activity: [facts.root, ...facts.descendants],
        requests: open.flatMap((c) =>
          c.reminder && c.reminder.key.object.kind === "request"
            ? [{ ...c.reminder, actionable: state.status === "current" && c.answerable === true }]
            : [],
        ),
      };
    });
  return { head, threadIds: rows.map((r) => r.summary.threadId), counts: scope.counts, rows };
}
