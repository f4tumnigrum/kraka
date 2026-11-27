import { sameRange, type EarlierSettledRequest, type EarlierSettledPage } from "@kraka/protocol";
import type { ThreadCacheStore } from "./thread-pass";
import { sameHead, comparePositions, type SyncCursor, type ThreadSummary } from "@kraka/protocol";
import { interpretAttention, compareText, reminderKeyId } from "./attention";
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
  return compareText(a.threadId, b.threadId);
}
export function installedList(
  cache: ThreadCache,
  state: Pick<ThreadFrameState, "installed" | "status">,
) {
  const head: SyncCursor | null = state.installed;
  const scope = head && cache.scopes[scopeKey(head)];
  if (!scope?.facts || !scope.listRows || !scope.counts || !head || !sameHead(scope.cursor, head))
    return null;
  const byRoot = new Map(
    Object.values(scope.facts).map((f) => {
      const { first, causes, needsHuman, open } = interpretAttention(f);
      const requests = open.flatMap((c) =>
        c.reminder && c.reminder.key.object.kind === "request"
          ? [{ ...c.reminder, actionable: state.status === "current" && c.answerable === true }]
          : [],
      );
      return [
        f.root.threadId,
        { state: first.kind, causes, needsHuman, activity: [f.root, ...f.descendants], requests },
      ] as const;
    }),
  );
  const rows = Object.values(scope.listRows)
    .sort(order)
    .map((summary) => {
      const reading = byRoot.get(summary.threadId);
      if (!reading) throw Error("Missing installed facts");
      return { summary, ...reading };
    });
  const requests = new Map(
    [...byRoot.values()].flatMap((r) => r.requests).map((r) => [reminderKeyId(r.key), r]),
  );
  return {
    head,
    threadIds: rows.map((r) => r.summary.threadId),
    counts: scope.counts,
    rows,
    requests: [...requests.values()],
  };
}

type After = EarlierSettledRequest["after"];
const earlierKey = (head: SyncCursor, after: After) =>
  JSON.stringify([
    head.environmentId,
    head.databaseGeneration,
    head.visibilityGeneration,
    scopeKey(head),
    after?.settledAt ?? null,
    after?.threadId ?? null,
  ]);
export function earlierPage(cache: ThreadCache, head: SyncCursor, after: After = null) {
  const page = cache.earlier?.[earlierKey(head, after)];
  return page ? { page, verified: sameHead(head, page.through) } : null;
}
export async function installEarlierPage(
  store: ThreadCacheStore,
  head: SyncCursor,
  after: After,
  page: EarlierSettledPage,
) {
  const scope = head.scope;
  if (
    scope.kind !== "list" ||
    !sameRange(page.through, head) ||
    (after && !sameHead(after.snapshot, page.through))
  )
    throw Error("Earlier settlement range changed");
  let last = after;
  const seen = new Set();
  for (const row of page.threads) {
    const at = row.lifecycle.state.at;
    if (
      seen.has(row.threadId) ||
      (scope.projectId !== null && scope.projectId !== row.projectId) ||
      (last &&
        (at > last.settledAt ||
          (at === last.settledAt && compareText(row.threadId, last.threadId) <= 0)))
    )
      throw Error("Invalid earlier settlement order");
    last = { snapshot: page.through, settledAt: at, threadId: row.threadId };
    seen.add(row.threadId);
  }
  if (
    page.next &&
    (!page.threads.length ||
      !last ||
      page.next.settledAt !== last.settledAt ||
      page.next.threadId !== last.threadId ||
      !sameHead(page.next.snapshot, page.through))
  )
    throw Error("Invalid earlier settlement continuation");
  const key = earlierKey(page.through, after);
  await store.transact((old) => {
    const previous = old.earlier?.[key];
    if (previous && comparePositions(previous.through.through, page.through.through) > 0)
      return { next: old, result: undefined };
    return { next: { ...old, earlier: { ...old.earlier, [key]: page } }, result: undefined };
  });
}
