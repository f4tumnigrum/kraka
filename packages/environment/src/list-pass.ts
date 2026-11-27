import {
  comparePositions,
  sameHead,
  sameScope,
  type AttentionFacts,
  type ObjectChange,
  type PrincipalId,
  type SignedRequest,
  type SyncCursor,
  type SyncPosition,
  type ThreadSummary,
  type ThreadId,
  type TodoRequest,
} from "@kraka/protocol";

export type ListOpen = Extract<SignedRequest, { method: "subscription.openList" }>["payload"];
type Earlier = Extract<SignedRequest, { method: "thread.readEarlierSettled" }>["payload"];
export type ListScope = Extract<SyncCursor["scope"], { kind: "list" }>;
export type ListSource = { summary: ThreadSummary; facts: AttentionFacts["root"] };
export type ListView = {
  head: SyncCursor;
  floor: SyncPosition;
  sources: Map<ThreadId, ListSource>;
  todos: Map<string, TodoRequest>;
};
type Settled = ThreadSummary & {
  lifecycle: {
    archivedAt: null;
    state: Extract<ThreadSummary["lifecycle"]["state"], { kind: "settled" }>;
  };
};
function isSettled(row: ThreadSummary): row is Settled {
  return row.lifecycle.archivedAt === null && row.lifecycle.state.kind === "settled";
}
function windowAt(view: ListView) {
  const counts = { active: 0, pinned: 0, snoozed: 0, settled: 0, archived: 0 };
  const members = new Set<ThreadId>();
  const settled: Settled[] = [];
  for (const { summary } of view.sources.values()) {
    const { lifecycle, threadId, parentThreadId } = summary;
    if (lifecycle.archivedAt !== null) {
      counts.archived++;
      continue;
    }
    if (lifecycle.state.kind === "active") {
      counts.active++;
      if (lifecycle.state.pinnedAt !== null) counts.pinned++;
      if (lifecycle.state.snoozedUntil !== null) counts.snoozed++;
      members.add(threadId);
    } else {
      counts.settled++;
      if (parentThreadId === null && isSettled(summary)) settled.push(summary);
    }
  }
  settled.sort(
    (a, b) =>
      b.lifecycle.state.at - a.lifecycle.state.at ||
      Buffer.compare(Buffer.from(a.threadId), Buffer.from(b.threadId)),
  );
  const cutoff = settled[24]?.lifecycle.state.at ?? 0;
  for (const row of settled) if (row.lifecycle.state.at >= cutoff) members.add(row.threadId);
  for (const id of members) {
    const parent = view.sources.get(id)?.summary.parentThreadId;
    if (parent && view.sources.get(parent)?.summary.lifecycle.archivedAt === null)
      members.add(parent);
  }
  return { counts, members, earlier: settled.filter((r) => !members.has(r.threadId)) };
}

export function earlierSettledPage(view: ListView, after: Earlier["after"]) {
  const { counts, earlier } = windowAt(view);
  if (after && !sameHead(after.snapshot, view.head)) return null;
  const index = after
    ? earlier.findIndex(
        (r) => r.threadId === after.threadId && r.lifecycle.state.at === after.settledAt,
      )
    : -1;
  if (after && index < 0) return null;
  const threads = earlier.slice(index + 1, index + 26);
  const last = threads.at(-1);
  return {
    through: view.head,
    threads,
    counts,
    next:
      last && index + 1 + threads.length < earlier.length
        ? { snapshot: view.head, settledAt: last.lifecycle.state.at, threadId: last.threadId }
        : null,
  };
}

export function planListPass({
  actor,
  scope,
  knownThreads,
  base,
  readView: view,
  recheckTodos = [],
}: {
  actor: PrincipalId;
  scope: ListScope;
  knownThreads: ListOpen["knownThreads"];
  base: SyncCursor | null;
  readView: ListView;
  recheckTodos?: ListOpen["recheckTodos"];
}) {
  const head = view.head;
  if (!sameScope(scope, head.scope) || (base && base.environmentId !== head.environmentId))
    return { kind: "invalidState" } as const;
  const reason =
    base &&
    (base.visibilityGeneration !== head.visibilityGeneration
      ? "authorizationChanged"
      : base.databaseGeneration !== head.databaseGeneration
        ? "databaseGenerationChanged"
        : !sameScope(scope, base.scope)
          ? "rangeChanged"
          : base.shapeVersion !== head.shapeVersion
            ? "shapeChanged"
            : comparePositions(base.through, view.floor) < 0 ||
                comparePositions(base.through, head.through) > 0
              ? "cursorExpired"
              : null);
  if (reason) return { kind: "reset", reason } as const;
  const { counts, members } = windowAt(view);
  const children = new Map<ThreadId, ListSource[]>();
  for (const source of view.sources.values()) {
    const parent = source.summary.parentThreadId;
    if (parent) {
      const group = children.get(parent) ?? [];
      group.push(source);
      children.set(parent, group);
    }
  }
  const changes: ObjectChange[] = [];
  const old = new Map((base ? knownThreads : []).map((t) => [t.threadId, t.version]));
  const installed = [];
  const covered = new Set<ThreadId>();
  for (const id of members) {
    const source = view.sources.get(id)!;
    const key = { objectType: "thread" as const, id };
    installed.push({ key, version: source.summary.version });
    if (old.get(id) !== source.summary.version)
      changes.push({ kind: "thread.summary", summary: source.summary });
    if (!old.has(id)) changes.push({ kind: "window.enter", key });
    if (base && sameHead(base, head) && old.has(id)) continue;
    const seen = new Set([id]),
      descendants: AttentionFacts["descendants"] = [];
    for (const parent of seen)
      for (const child of children.get(parent) ?? []) {
        if (seen.has(child.summary.threadId)) continue;
        seen.add(child.summary.threadId);
        descendants.push(child.facts);
      }
    for (const sourceId of seen) covered.add(sourceId);
    changes.push({
      kind: "attention.facts",
      facts: {
        ownerId: actor,
        environmentId: head.environmentId,
        databaseGeneration: head.databaseGeneration,
        through: head.through,
        root: source.facts,
        descendants,
      },
    });
  }
  if (!base || !sameHead(base, head)) {
    for (const [id, source] of view.sources) {
      if (
        covered.has(id) ||
        source.facts.grouping === "archived" ||
        !source.facts.requests.some((r) => r.answerable && r.request.state.kind === "open")
      )
        continue;
      changes.push({
        kind: "attention.facts",
        facts: {
          ownerId: actor,
          environmentId: head.environmentId,
          databaseGeneration: head.databaseGeneration,
          through: head.through,
          root: source.facts,
          descendants: [],
        },
      });
    }
  }
  for (const id of old.keys())
    if (!members.has(id)) changes.push({ kind: "window.leave", key: { objectType: "thread", id } });
  for (const id of new Set(recheckTodos)) {
    const request = view.todos.get(id);
    changes.push({
      kind: "todo.reconcile",
      todoRequestId: id,
      result: request ? { kind: "current", request } : { kind: "inaccessible" },
    });
  }
  changes.push({ kind: "list.counts", counts });
  return {
    kind: "pass",
    mode: base ? "merge" : "replace",
    base,
    through: head,
    changes,
    members: installed,
  } as const;
}
