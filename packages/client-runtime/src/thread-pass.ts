import * as v from "valibot";
import {
  canonicalJson,
  comparePositions,
  ControlMessageSchema,
  HistoryPageSchema,
  keyString,
  readSubscriptionPage,
  rowKey,
  sameHead,
  sameRange,
  sameScope,
  type CommandReceipt,
  type MessageId,
  type ControlMessage,
  type HistoryCoverage,
  type HistoryPage,
  type HistoryRow,
  type ObjectChange,
  type ObjectKey,
  type ObjectVersion,
  type SignedRequest,
  type SubscriptionPage,
  type SyncCursor,
  type SyncPassId,
  type TextReturnedEvent,
  type WorkRelationship,
} from "@kraka/protocol";

type Open = Extract<SignedRequest, { method: "subscription.openThread" | "subscription.openList" }>;
type Begin = Extract<ControlMessage, { kind: "subscription.begin" }>;
type Seal = Extract<ControlMessage, { kind: "subscription.seal" }>;
export type SealedPass = {
  begin: Begin;
  pages: readonly SubscriptionPage[];
  recheck: ReadonlySet<string>;
};
type Pending = {
  begin: Begin;
  pages: Map<number, SubscriptionPage>;
  count: number | null;
  seal: Seal | null;
};
export interface ThreadFrameState {
  request: Open;
  installed: SyncCursor | null;
  bound: boolean;
  status: "empty" | "cached" | "syncing" | "current" | "gap";
  pending: Pending | null;
  abandoned: Set<SyncPassId>;
  lastSeal: Seal | null;
}
export function openThreadFrames(
  request: Open,
  installed: SyncCursor | null = request.payload.after,
): ThreadFrameState {
  return {
    request,
    installed,
    bound: false,
    status: installed ? "cached" : "empty",
    pending: null,
    abandoned: new Set(),
    lastSeal: null,
  };
}
type Event =
  | { kind: "ignored" | "gap" | "staged" | "bound" }
  | { kind: "sealed"; pass: SealedPass }
  | { kind: "repeatInstalled"; seal: Seal }
  | { kind: "reset"; reason: Extract<ControlMessage, { kind: "subscription.reset" }>["reason"] }
  | { kind: "ended"; revoked: boolean };
function gap(s: ThreadFrameState): Event {
  s.status = "gap";
  s.pending = null;
  return { kind: "gap" };
}
function ready(s: ThreadFrameState): Event {
  const p = s.pending;
  if (!s.bound || !p?.seal) return { kind: "staged" };
  const pages = [...p.pages.values()].sort((a, b) => a.pageNumber - b.pageNumber);
  return {
    kind: "sealed",
    pass: {
      begin: p.begin,
      pages,
      recheck: new Set(s.lastSeal ? [] : s.request.payload.recheckTodos),
    },
  };
}
export function stageThreadFrame(
  s: ThreadFrameState,
  frame: { epoch: string; streamId: number; message: unknown },
): Event {
  const req = s.request;
  if (frame.epoch !== req.connectionId || !frame.message || typeof frame.message !== "object")
    return { kind: "ignored" };
  const raw = frame.message;
  if (!("kind" in raw)) return { kind: "ignored" };
  const page = raw.kind === "subscription.page";
  if (frame.streamId !== (page ? req.payload.streamId : 0)) return { kind: "ignored" };
  if ("subscriptionId" in raw && raw.subscriptionId !== req.payload.subscriptionId)
    return { kind: "ignored" };
  if (
    "passId" in raw &&
    typeof raw.passId === "string" &&
    [...s.abandoned].some((id) => id === raw.passId)
  )
    return { kind: "ignored" };
  if (
    s.status === "gap" &&
    (raw.kind !== "subscription.ended" ||
      !("reason" in raw) ||
      raw.reason !== "authorizationRevoked")
  )
    return { kind: "ignored" };
  if (page) {
    const p = s.pending;
    if (!p || !("passId" in raw) || raw.passId !== p.begin.passId) return { kind: "ignored" };
    const result = readSubscriptionPage(raw, s.installed);
    if (result.kind === "gap") return gap(s);
    const m = result.page,
      old = p.pages.get(m.pageNumber);
    if (
      !sameHead(m.through, p.begin.through) ||
      m.pageNumber >= m.pageCount ||
      (p.count !== null && p.count !== m.pageCount) ||
      (old && canonicalJson(old) !== canonicalJson(m))
    )
      return gap(s);
    if (old) return { kind: "ignored" };
    p.count = m.pageCount;
    p.pages.set(m.pageNumber, m);
    return { kind: "staged" };
  }
  const parsed = v.safeParse(ControlMessageSchema, raw);
  if (!parsed.success) return gap(s);
  const m = parsed.output;
  if (m.kind === "accepted" || m.kind === "rejected" || m.kind === "programError") {
    if (m.commandId !== req.commandId) return { kind: "ignored" };
    if (
      m.kind !== "accepted" ||
      m.result.kind !== "subscriptionOpened" ||
      m.result.subscriptionId !== req.payload.subscriptionId ||
      m.result.streamId !== req.payload.streamId
    )
      return gap(s);
    s.bound = true;
    s.status = "syncing";
    return s.pending?.seal ? ready(s) : { kind: "bound" };
  }
  if (m.kind === "subscription.ended" || m.kind === "subscription.reset") {
    s.pending = null;
    if (s.status !== "gap") s.status = s.installed ? "cached" : "empty";
    return m.kind === "subscription.reset"
      ? { kind: "reset", reason: m.reason }
      : { kind: "ended", revoked: m.reason === "authorizationRevoked" };
  }
  if (m.kind === "subscription.begin") {
    const scope =
      req.method === "subscription.openThread"
        ? { kind: "thread" as const, threadId: req.payload.threadId }
        : { kind: "list" as const, projectId: req.payload.projectId };
    if (
      m.through.environmentId !== req.environmentId ||
      !sameScope(scope, m.through.scope) ||
      (m.mode === "replace"
        ? m.base !== null || s.lastSeal !== null || req.payload.after !== null
        : !m.base ||
          !sameHead(m.base, s.installed) ||
          !sameRange(m.base, m.through) ||
          comparePositions(m.base.through, m.through.through) > 0)
    )
      return gap(s);
    if (s.pending?.begin.passId === m.passId)
      return canonicalJson(m) === canonicalJson(s.pending.begin) ? { kind: "ignored" } : gap(s);
    if (s.lastSeal?.passId === m.passId) return { kind: "ignored" };
    if (s.pending) s.abandoned.add(s.pending.begin.passId);
    s.pending = { begin: m, pages: new Map(), count: null, seal: null };
    s.status = "syncing";
    return { kind: "staged" };
  }
  if (m.kind === "subscription.seal") {
    if (s.lastSeal?.passId === m.passId)
      return canonicalJson(m) === canonicalJson(s.lastSeal)
        ? { kind: "repeatInstalled", seal: m }
        : gap(s);
    const p = s.pending;
    if (!p || m.passId !== p.begin.passId) return { kind: "ignored" };
    if (
      !sameHead(m.cursor, p.begin.through) ||
      m.pages > 65536 ||
      m.pages !== p.pages.size ||
      m.pages !== (p.count ?? 0)
    )
      return gap(s);
    p.seal = m;
    return ready(s);
  }
  return { kind: "ignored" };
}
export type SavedRow = { version: ObjectVersion; row: HistoryRow | null };
type AcceptedInput = { threadId: string; messageId: MessageId; text: string };
type Membership = {
  cursor: SyncCursor;
  members: Record<string, ObjectKey>;
  counts: Extract<ObjectChange, { kind: "list.counts" }>["counts"] | null;
};
type SavedPage = Pick<HistoryPage, "threadId" | "anchor" | "verifiedAt" | "olderAnchor"> & {
  keys: string[];
  timelineItems: boolean;
};
export interface ThreadCache {
  format: 1;
  rows: Record<string, SavedRow>;
  scopes: Record<string, Membership>;
  history: Record<string, SavedPage>;
  accepted: Record<string, AcceptedInput>;
  returns: Record<string, TextReturnedEvent>;
  summaries: Record<string, Extract<ObjectChange, { kind: "thread.summary" }>["summary"]>;
}
export function emptyThreadCache(): ThreadCache {
  return { format: 1, accepted: {}, rows: {}, scopes: {}, history: {}, returns: {}, summaries: {} };
}
export function cacheNamespace(principal: string, head: SyncCursor) {
  return JSON.stringify([
    principal,
    head.environmentId,
    head.databaseGeneration,
    head.visibilityGeneration,
    head.shapeVersion,
  ]);
}
export function scopeKey(head: SyncCursor) {
  return canonicalJson(head.scope);
}
export interface ThreadCacheStore {
  // The host holds one transaction or exclusive namespace lease from reading the value through commit.
  transact<T>(edit: (current: ThreadCache) => { next: ThreadCache; result: T }): Promise<T>;
}
export function reflectInputReceipt(
  store: ThreadCacheStore,
  command: Extract<SignedRequest, { method: "input.send" }>,
  receipt: CommandReceipt,
) {
  if (
    receipt.commandId !== command.commandId ||
    receipt.kind !== "accepted" ||
    receipt.result.kind !== "inputScheduled"
  )
    return;
  const messageId = receipt.result.messageId;
  const local = {
    messageId,
    threadId: command.payload.threadId,
    text: command.payload.content.text,
  };
  return store.transact((old) => {
    const key = JSON.stringify(command.commandId);
    if (
      old.rows[keyString({ objectType: "message", id: messageId })] ||
      old.accepted?.[key]?.messageId === messageId
    )
      return { next: old, result: undefined };
    return { next: { ...old, accepted: { ...old.accepted, [key]: local } }, result: undefined };
  });
}
function updateRow(
  cache: ThreadCache,
  key: ObjectKey,
  version: ObjectVersion,
  row: HistoryRow | null,
) {
  const id = keyString(key),
    prior = cache.rows[id];
  if (prior) {
    const cmp = comparePositions(version, prior.version);
    if (cmp < 0) return;
    if (cmp === 0) {
      if (canonicalJson(prior.row) !== canonicalJson(row))
        throw Error("Conflicting object version");
      return;
    }
    if (
      prior.row?.objectType === "timelineItem" &&
      row?.objectType === "timelineItem" &&
      (prior.row.value.kind !== row.value.kind ||
        prior.row.value.createdPosition !== row.value.createdPosition ||
        canonicalJson(prior.row.value.source) !== canonicalJson(row.value.source))
    )
      throw Error("Timeline origin changed");
  }
  cache.rows[id] = { version, row };
}
function saveRow(cache: ThreadCache, row: HistoryRow) {
  updateRow(cache, rowKey(row), row.value.version, row);
}
export async function installThreadPass(
  store: ThreadCacheStore,
  expectedBase: SyncCursor | null,
  sealedPass: SealedPass,
) {
  const { begin, pages, recheck } = sealedPass;
  return store.transact<"installed" | "staleBase">((old) => {
    const key = scopeKey(begin.through),
      prior = old.scopes[key];
    if (
      !sameHead(prior?.cursor ?? null, expectedBase) ||
      (begin.mode === "merge" && !sameHead(begin.base, expectedBase))
    )
      return { next: old, result: "staleBase" };
    const cache = {
      ...old,
      accepted: { ...old.accepted },
      rows: { ...old.rows },
      scopes: { ...old.scopes },
      returns: { ...old.returns },
      summaries: { ...old.summaries },
    };
    const scope: Membership = {
      cursor: begin.through,
      members: begin.mode === "replace" ? {} : { ...prior?.members },
      counts: begin.mode === "replace" ? null : (prior?.counts ?? null),
    };
    const seen = new Map<string, string>();
    let counts: string | null = null;
    for (const page of pages)
      for (const change of page.changes) {
        switch (change.kind) {
          case "object.replace":
            saveRow(cache, change.object);
            break;
          case "object.remove":
            updateRow(cache, change.key, change.version, null);
            delete scope.members[keyString(change.key)];
            break;
          case "window.enter":
            scope.members[keyString(change.key)] = change.key;
            break;
          case "window.leave":
            delete scope.members[keyString(change.key)];
            break;
          case "tool.activity":
            saveRow(cache, { objectType: "timelineItem", value: change.item });
            break;
          case "executor.observation":
            saveRow(cache, { objectType: "timelineItem", value: change.observation });
            break;
          case "handoff.textReturned": {
            const k = JSON.stringify(change.result.transferId),
              old = cache.returns[k];
            const cmp = old ? comparePositions(change.version, old.version) : 1;
            if (cmp === 0 && canonicalJson(old) !== canonicalJson(change))
              throw Error("Conflicting return version");
            if (cmp > 0) cache.returns[k] = change;
            break;
          }
          case "todo.reconcile": {
            const id = change.todoRequestId,
              encoded = canonicalJson(change.result);
            if (seen.has(id) && seen.get(id) !== encoded)
              throw Error("Conflicting todo reconciliation");
            seen.set(id, encoded);
            const k = keyString({ objectType: "todoRequest", id });
            if (change.result.kind === "current") {
              if (id !== change.result.request.id) throw Error("Wrong reconciled request");
              saveRow(cache, { objectType: "todoRequest", value: change.result.request });
            } else {
              if (cache.rows[k]?.row) delete cache.rows[k];
              delete scope.members[k];
            }
            break;
          }
          case "thread.summary": {
            if (begin.through.scope.kind !== "list") throw Error("Summary outside list");
            const k = JSON.stringify(change.summary.threadId),
              old = cache.summaries[k];
            const cmp = old ? comparePositions(change.summary.version, old.version) : 1;
            if (cmp === 0 && canonicalJson(old) !== canonicalJson(change.summary))
              throw Error("Conflicting summary");
            if (cmp > 0) cache.summaries[k] = change.summary;
            break;
          }
          case "list.counts": {
            const value = canonicalJson(change.counts);
            if (begin.through.scope.kind !== "list" || (counts !== null && counts !== value))
              throw Error("Conflicting counts");
            counts = value;
            scope.counts = change.counts;
            break;
          }
          default:
            throw Error("Unsupported required change");
        }
      }
    if ([...recheck].some((id) => !seen.has(id))) throw Error("Missing todo reconciliation");
    if (begin.through.scope.kind === "list" && scope.counts === null)
      throw Error("Missing list counts");
    for (const [k, member] of Object.entries(scope.members)) {
      if (
        begin.through.scope.kind === "list" && member.objectType === "thread"
          ? !cache.summaries[JSON.stringify(member.id)]
          : !cache.rows[k]?.row
      )
        throw Error("Missing member");
    }
    for (const [command, input] of Object.entries(cache.accepted))
      if (cache.rows[keyString({ objectType: "message", id: input.messageId })])
        delete cache.accepted[command];
    cache.scopes[key] = scope;
    return { next: cache, result: "installed" };
  });
}
export function relationshipCoverage(
  relationship: Extract<WorkRelationship, { kind: "providerHandoff" }>,
): HistoryCoverage {
  return relationship.history ?? { coverage: "unknown", omittedItems: null };
}
export async function installHistoryPage(
  store: ThreadCacheStore,
  raw: unknown,
  binding: {
    head: SyncCursor;
    threadId: string;
    anchor: string | null;
    timelineItems: boolean;
    allows: (row: HistoryRow) => boolean;
  },
) {
  const page = v.parse(HistoryPageSchema, raw);
  if (
    page.threadId !== binding.threadId ||
    !sameRange(page.verifiedAt, binding.head) ||
    (binding.anchor !== null && page.anchor !== binding.anchor) ||
    page.pageCount !== 1 ||
    page.pageNumber !== 0
  )
    throw Error("History range changed");
  return store.transact((old) => {
    const cache = { ...old, rows: { ...old.rows }, history: { ...old.history } };
    for (const row of page.rows) {
      if (!binding.allows(row) || (!binding.timelineItems && row.objectType === "timelineItem"))
        throw Error("Out-of-range history row");
      saveRow(cache, row);
    }
    const id = JSON.stringify(page.anchor),
      prior = cache.history[id];
    if (!prior || comparePositions(prior.verifiedAt.through, page.verifiedAt.through) <= 0)
      cache.history[id] = {
        threadId: page.threadId,
        anchor: page.anchor,
        verifiedAt: page.verifiedAt,
        olderAnchor: page.olderAnchor,
        keys: page.rows.map((row) => keyString(rowKey(row))),
        timelineItems: binding.timelineItems,
      };
    return { next: cache, result: page.verifiedAt };
  });
}
export function cachedHistory(cache: ThreadCache, anchor: string, current: SyncCursor | null) {
  const page = cache.history[JSON.stringify(anchor)];
  if (!page) return null;
  return {
    ...page,
    verified: sameHead(page.verifiedAt, current),
    rows: page.keys.flatMap((k) => cache.rows[k]?.row ?? []),
  };
}
