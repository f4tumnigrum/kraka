import { isTerminalRoundPhase } from "@kraka/protocol";
import {
  comparePositions,
  keyString,
  rowKey,
  sameScope,
  type HistoryRow,
  type ObjectChange,
  type ObjectKey,
  type ObjectVersion,
  type SignedRequest,
  type SyncCursor,
  type SyncPosition,
  type ThreadId,
  type TodoRequest,
  type TextReturnedEvent,
} from "@kraka/protocol";

export type ThreadOpen = Extract<SignedRequest, { method: "subscription.openThread" }>["payload"];
export type ReadRow = {
  row: HistoryRow;
  source: ThreadId;
  round: string | null;
  created: SyncPosition;
  changed: SyncPosition;
};
export type ReadDeletion = {
  key: ObjectKey;
  source: ThreadId;
  created: SyncPosition;
  changed: SyncPosition;
  version: ObjectVersion;
};
export interface ThreadReadView {
  head: SyncCursor;
  floor: SyncPosition;
  rows: readonly ReadRow[];
  deletions: readonly ReadDeletion[];
  operations?: readonly {
    changed: SyncPosition;
    operation: import("@kraka/protocol").ContextOperation;
  }[];
  returns: readonly { source: ThreadId; event: TextReturnedEvent; changed: SyncPosition }[];
}
export interface AuthorizedScope {
  threadId: ThreadId;
  environmentId: SyncCursor["environmentId"];
  canRead: (source: ThreadId) => boolean;
  timelineItems: boolean;
  directoryDiff?: boolean;
  protocolMinor: number;
}
function readSources(scope: AuthorizedScope, view: ThreadReadView) {
  const sources = new Map<ThreadId, SyncPosition>();
  let source = scope.threadId,
    cutoff = view.head.through;
  while (scope.canRead(source) && !sources.has(source)) {
    sources.set(source, cutoff);
    const thread = view.rows.find(
      (item) => item.source === source && item.row.objectType === "thread",
    );
    if (thread?.row.objectType !== "thread" || thread.row.value.lineage.kind !== "fork") break;
    const { parentThreadId, sourceRoundId } = thread.row.value.lineage;
    const forkRound = view.rows.find(
      (item) =>
        item.source === parentThreadId &&
        item.row.objectType === "round" &&
        item.row.value.id === sourceRoundId,
    );
    if (!forkRound) break;
    // Ancestor edits stay visible at their original positions. The branch cannot acquire later entries.
    const next = view.rows
      .filter(
        (item) =>
          item.source === parentThreadId &&
          item.round === sourceRoundId &&
          comparePositions(item.created, thread.created) <= 0,
      )
      .reduce(
        (pos, item) => (comparePositions(pos, item.created) < 0 ? item.created : pos),
        forkRound.created,
      );
    if (comparePositions(next, cutoff) < 0) cutoff = next;
    source = parentThreadId;
  }
  return sources;
}
function textOrder(a: string, b: string) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
export function orderRows(a: ReadRow, b: ReadRow) {
  return (
    comparePositions(a.created, b.created) ||
    textOrder(a.source, b.source) ||
    textOrder(a.row.objectType, b.row.objectType) ||
    textOrder(a.row.value.id, b.row.value.id)
  );
}
export function visibleThreadRows(scope: AuthorizedScope, view: ThreadReadView) {
  const sources = readSources(scope, view);
  const visible = (item: { source: ThreadId; created: SyncPosition }) => {
    const cutoff = sources.get(item.source);
    return cutoff !== undefined && comparePositions(item.created, cutoff) <= 0;
  };
  return {
    rows: view.rows.filter(
      (item) => visible(item) && (scope.timelineItems || item.row.objectType !== "timelineItem"),
    ),
    visible,
  };
}
export function historyEntries(rows: readonly ReadRow[]) {
  return rows
    .filter((item) => ["message", "timelineItem", "round"].includes(item.row.objectType))
    .sort((a, b) => orderRows(b, a));
}
export function boundedEntries(entries: readonly ReadRow[]) {
  const rounds = new Set<string>();
  const selected: ReadRow[] = [];
  let count = 0;
  for (const item of entries) {
    if (item.round !== null) rounds.add(JSON.stringify([item.source, item.round]));
    if (rounds.size > 10 || count >= 40) break;
    selected.push(item);
    if (item.row.objectType !== "round") count++;
  }
  return selected;
}
function threadWindow(threadId: ThreadId, rows: readonly ReadRow[], requested: readonly string[]) {
  const selected = new Map<string, ReadRow>();
  const byKey = new Map(rows.map((item) => [keyString(rowKey(item.row)), item]));
  function add(item: ReadRow | undefined) {
    if (!item) return;
    const key = keyString(rowKey(item.row));
    if (selected.has(key)) return;
    selected.set(key, item);
    const row = item.row;
    const related = (type: string, id: string) => add(byKey.get(JSON.stringify([type, id])));
    if (row.objectType === "round") {
      related("message", row.value.messageId);
      const phase = row.value.attempt.phase;
      if (phase.kind === "finished") related("checkpointCapture", phase.captureId);
    }
    if (row.objectType === "message" && row.value.roundId) related("round", row.value.roundId);
    if (row.objectType === "todoRequest") {
      related("round", row.value.roundId);
      const state = row.value.state;
      if (state.kind === "answered" && state.answer.content.kind === "message")
        related("message", state.answer.content.messageId);
      if (state.kind !== "expired" && state.route.kind === "message")
        for (const id of state.route.questions) related("message", id);
    }
  }
  const inactive = new Set(
    rows.flatMap((item) =>
      item.row.objectType === "round" && item.row.value.rolledBackBy
        ? [item.row.value.id as string]
        : [],
    ),
  );
  for (const item of boundedEntries(
    historyEntries(rows.filter((r) => r.round === null || !inactive.has(r.round))),
  ))
    add(item);
  for (const item of rows) {
    const row = item.row;
    if (item.source !== threadId) continue;
    if (
      row.objectType === "thread" ||
      (row.objectType === "todoRequest" &&
        (row.value.state.kind === "open" || requested.includes(row.value.id))) ||
      (row.objectType === "round" && !isTerminalRoundPhase(row.value.attempt.phase))
    )
      add(item);
  }
  for (const item of rows) {
    const row = item.row;
    if (row.objectType !== "todoRequest" || row.value.state.kind !== "answered") continue;
    const content = row.value.state.answer.content;
    const link =
      content.kind === "message" ? ["message", content.messageId] : ["round", row.value.roundId];
    if (selected.has(JSON.stringify(link))) add(item);
  }
  return selected;
}
function replacement(row: HistoryRow): ObjectChange {
  if (row.objectType !== "timelineItem") return { kind: "object.replace", object: row };
  return row.value.kind === "toolActivity"
    ? { kind: "tool.activity", item: row.value }
    : { kind: "executor.observation", observation: row.value };
}
export function planThreadPass({
  authorizedScope: scope,
  after,
  knownWindow,
  recheckTodos,
  readView: view,
}: {
  authorizedScope: AuthorizedScope;
  readView: ThreadReadView;
} & Pick<ThreadOpen, "after" | "knownWindow" | "recheckTodos">) {
  const head = view.head;
  if (
    head.environmentId !== scope.environmentId ||
    (after && after.environmentId !== scope.environmentId)
  )
    return { kind: "invalidState" } as const;
  if (
    !scope.canRead(scope.threadId) ||
    head.scope.kind !== "thread" ||
    head.scope.threadId !== scope.threadId ||
    !view.rows.some(
      (item) => item.row.objectType === "thread" && item.row.value.id === scope.threadId,
    )
  )
    return { kind: "authorizationRevoked" } as const;
  const reason =
    after &&
    (after.visibilityGeneration !== head.visibilityGeneration
      ? "authorizationChanged"
      : after.databaseGeneration !== head.databaseGeneration
        ? "databaseGenerationChanged"
        : !sameScope(after.scope, head.scope)
          ? "rangeChanged"
          : after.shapeVersion !== head.shapeVersion
            ? "shapeChanged"
            : comparePositions(after.through, view.floor) < 0 ||
                comparePositions(after.through, head.through) > 0
              ? "cursorExpired"
              : null);
  if (reason) return { kind: "reset", reason } as const;
  const { rows, visible } = visibleThreadRows(scope, view);
  const members = threadWindow(scope.threadId, rows, recheckTodos);
  const old = new Map((after ? knownWindow : []).map(({ key }) => [keyString(key), key]));
  const changes: ObjectChange[] = [];
  const changed = (position: SyncPosition) =>
    comparePositions(position, head.through) <= 0 &&
    (!after || comparePositions(position, after.through) > 0);
  const sorted = [...rows].sort(
    (a, b) =>
      comparePositions(a.changed, b.changed) ||
      textOrder(a.row.objectType, b.row.objectType) ||
      textOrder(a.row.value.id, b.row.value.id),
  );
  const todos = new Map<string, TodoRequest>();
  for (const item of sorted) {
    const row = item.row,
      key = rowKey(row),
      k = keyString(key);
    if (row.objectType === "todoRequest" && item.source === scope.threadId)
      todos.set(row.value.id, row.value);
    const entering = members.has(k) && !old.has(k);
    if (
      entering ||
      (changed(item.changed) &&
        (members.has(k) || (after && (row.objectType === "timelineItem" || old.has(k)))))
    )
      changes.push(replacement(row));
    if (entering) changes.push({ kind: "window.enter", key });
  }
  for (const item of view.deletions)
    if (
      after &&
      changed(item.changed) &&
      visible(item) &&
      (scope.timelineItems || item.key.objectType !== "timelineItem")
    )
      changes.push({ kind: "object.remove", key: item.key, version: item.version });
  for (const [k, key] of old) if (!members.has(k)) changes.push({ kind: "window.leave", key });
  for (const item of view.operations ?? [])
    if (item.operation.threadId === scope.threadId && changed(item.changed))
      changes.push({ kind: "context.operation", operation: item.operation });
  for (const item of view.returns)
    if (item.source === scope.threadId && changed(item.changed)) changes.push(item.event);
  for (const id of new Set(recheckTodos)) {
    const request = todos.get(id);
    const removed = view.deletions.some(
      (item) =>
        item.source === scope.threadId &&
        item.key.objectType === "todoRequest" &&
        item.key.id === id,
    );
    changes.push({
      kind: "todo.reconcile",
      todoRequestId: id,
      result: request
        ? { kind: "current", request }
        : { kind: removed ? "removed" : "inaccessible" },
    });
  }
  return {
    kind: "pass",
    mode: after ? "merge" : "replace",
    base: after,
    through: head,
    changes,
    members: [...members.values()].map(({ row }) => ({
      key: rowKey(row),
      version: row.value.version,
    })),
  } as const;
}
