import { decodeJournalRow, encodeJournalRow } from "./journal-row";
import { markStartupDetail } from "./capture-timing";
import { ListIndex } from "./list-index";
import type { ListScope } from "./list-pass";
import type { PrincipalId, TodoRequest, Round, SyncPosition } from "@kraka/protocol";
import type { Database } from "bun:sqlite";
import { promoteSessionObservation } from "./session-observations";
import { AttemptIdSchema, ExecutorInstanceIdSchema, NativeSessionIdSchema } from "@kraka/protocol";
import { ToolActivityStorage } from "./tool-activity-storage";
import * as v from "valibot";
import {
  HistoryPageSchema,
  ExecutorSessionObservationSchema,
  type ExecutorSessionObservation,
  HistoryAnchorIdSchema,
  ObjectKeySchema,
  ObjectVersionSchema,
  SyncCursorSchema,
  SyncPositionSchema,
  ThreadIdSchema,
  TimelineItemIdSchema,
  ToolActivityBodySchema,
  TextReturnedEventSchema,
  ChildResultTransferSchema,
  type ChildResultTransfer,
  keyString,
  rowKey,
  roundForProtocol,
  type HistoryPage,
  type HistoryRow,
  type ObjectKey,
  type ThreadId,
  type EnvironmentId,
  type TextReturnedEvent,
  type TimelineItemId,
  type ToolActivityHistoryItem,
} from "@kraka/protocol";
import {
  boundedEntries,
  historyEntries,
  visibleThreadRows,
  type ThreadReadView,
  type AuthorizedScope,
  type ReadRow,
} from "./thread-pass";
import {
  evolveToolActivity,
  type StoredToolActivityVersion,
  type ToolActivityEvent,
} from "./tool-activity";

const rowSchema = HistoryPageSchema.entries.rows.item;
type Meta = { generation: string; head: string; floor: string };
type Entry = {
  source: string;
  round: string | null;
  payload: string | null;
  key: string;
  version: string;
  created: string;
  changed: string;
};
const orderBound = v.strictObject({
  created: SyncPositionSchema,
  source: ThreadIdSchema,
  type: v.string(),
  id: v.string(),
});
type Bound = v.InferOutput<typeof orderBound>;
const bound = (item: ReadRow): Bound => ({
  created: item.created,
  source: item.source,
  type: item.row.objectType,
  id: item.row.value.id,
});
function orderBounded(item: ReadRow, edge: Bound) {
  const pos = BigInt(item.created) - BigInt(edge.created);
  if (pos) return pos < 0n ? -1 : 1;
  for (const [a, b] of [
    [item.source, edge.source],
    [item.row.objectType, edge.type],
    [item.row.value.id, edge.id],
  ] as const) {
    const cmp = Buffer.compare(Buffer.from(a), Buffer.from(b));
    if (cmp) return cmp;
  }
  return 0;
}
export class ThreadJournal {
  private readonly listeners = new Set<() => void>();
  private constructor(
    readonly db: Database,
    readonly environmentId: EnvironmentId,
    private readonly activities: ToolActivityStorage,
    readonly list: ListIndex,
  ) {}
  static open(db: Database, environmentId: EnvironmentId) {
    return db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,head TEXT NOT NULL,floor TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS sync_rows(source TEXT NOT NULL,key TEXT NOT NULL,round TEXT,created TEXT NOT NULL,changed TEXT NOT NULL,version TEXT NOT NULL,payload TEXT,PRIMARY KEY(source,key));
     CREATE TABLE IF NOT EXISTS sync_returns(source TEXT NOT NULL,id TEXT NOT NULL,changed TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,id));
     CREATE TABLE IF NOT EXISTS sync_child_returns(source TEXT NOT NULL,id TEXT NOT NULL,changed TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,id));
     CREATE TABLE IF NOT EXISTS sync_anchors(id TEXT PRIMARY KEY,binding TEXT NOT NULL,high TEXT,low TEXT);
     CREATE TABLE IF NOT EXISTS tool_activity_scoped_changes(thread_id TEXT NOT NULL,event_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread_id,event_id));`);
      markStartupDetail("db.journal");
      const activities = ToolActivityStorage.open(db);
      markStartupDetail("db.activities");
      const list = ListIndex.open(db);
      markStartupDetail("db.list");
      const journal = new ThreadJournal(db, environmentId, activities, list);
      if (journal.meta()) return journal;
      db.run("INSERT INTO sync_meta VALUES(1,?,'0','0')", [crypto.randomUUID()]);
      const rows: HistoryRow[] = [];
      for (const [table, objectType] of [
        ["threads", "thread"],
        ["messages", "message"],
        ["rounds", "round"],
      ] as const) {
        for (const { data } of db
          .query<{ data: string }, []>(`SELECT data FROM ${table} ORDER BY rowid`)
          .all())
          rows.push(v.parse(rowSchema, { objectType, value: JSON.parse(data) }));
      }
      if (rows.length) journal.record(rows);
      return journal;
    })();
  }
  private meta() {
    return this.db.query<Meta, []>("SELECT generation,head,floor FROM sync_meta WHERE id=1").get();
  }
  nextPosition() {
    const meta = this.meta();
    if (!meta) throw Error("Missing sync clock");
    return v.parse(SyncPositionSchema, String(BigInt(meta.head) + 1n));
  }
  saveObservation(
    threadId: ThreadId,
    source: ExecutorSessionObservation["source"],
    change: (old: ExecutorSessionObservation | null) => ExecutorSessionObservation,
  ) {
    const updated = this.db
      .transaction(() => {
        const previous = this.db
          .query<{ payload: string }, [string, string, string, number, string, string]>(
            "SELECT payload FROM sync_rows WHERE source=? AND json_extract(payload,'$.value.kind')='executorObservation' AND json_extract(payload,'$.value.source.instanceId')=? AND json_extract(payload,'$.value.source.nativeSessionId')=? AND json_extract(payload,'$.value.source.epoch')=? AND json_extract(payload,'$.value.source.eventId')=? AND json_extract(payload,'$.value.source.sourceId')=?",
          )
          .get(
            threadId,
            source.instanceId,
            source.nativeSessionId,
            source.epoch,
            source.eventId,
            source.sourceId,
          );
        const prior = previous
          ? v.parse(ExecutorSessionObservationSchema, JSON.parse(previous.payload).value)
          : null;
        const next = change(prior);
        if (prior === next) return false;
        this.record([{ objectType: "timelineItem", value: next }]);
        return true;
      })
      .immediate();
    if (updated && !this.db.inTransaction) this.notify();
    return updated;
  }
  subscribe(wake: () => void) {
    this.listeners.add(wake);
    return () => {
      this.listeners.delete(wake);
    };
  }
  private pendingWake = false;
  notify() {
    if (this.db.inTransaction) {
      if (!this.pendingWake) {
        this.pendingWake = true;
        queueMicrotask(() => {
          this.pendingWake = false;
          for (const wake of this.listeners) wake();
        });
      }
      return;
    }
    for (const wake of this.listeners) wake();
  }
  private advanceClock() {
    const meta = this.meta();
    if (!meta) throw Error("Missing sync clock");
    const position = String(BigInt(meta.head) + 1n);
    this.db.run("UPDATE sync_meta SET head=? WHERE id=1", [position]);
    return position;
  }
  markRead(actor: PrincipalId, thread: ThreadId, through: SyncPosition) {
    const changed = this.db.transaction(() => {
      const current = this.db
        .query<{ position: string }, [string, string]>(
          "SELECT position FROM list_watermarks WHERE owner=? AND source=?",
        )
        .get(actor, thread);
      if (current && BigInt(current.position) >= BigInt(through)) return false;
      this.db
        .query(
          "INSERT INTO list_watermarks VALUES(?,?,?) ON CONFLICT(owner,source) DO UPDATE SET position=excluded.position",
        )
        .run(actor, thread, through);
      this.advanceClock();
      return true;
    })();
    if (changed) this.notify();
  }
  observeQuota(
    round: Pick<Round, "id" | "threadId" | "attempt">,
    quota: { resetAt: number | null } | null,
  ) {
    const changed = this.db.transaction(() => {
      const sql = this.db.query(`UPDATE list_attempts SET data=json_set(data,'$.quota',json(?))
        WHERE source=? AND round=? AND attempt=? AND terminal=0 AND json_extract(data,'$.quota') IS NOT json_extract(?,'$')`);
      const value = JSON.stringify(quota);
      if (!sql.run(value, round.threadId, round.id, round.attempt.attemptId, value).changes)
        return false;
      this.advanceClock();
      return true;
    })();
    if (changed) this.notify();
  }
  record(
    rows: readonly HistoryRow[],
    extras: {
      removed?: readonly { source: ThreadId; key: ObjectKey; version: string }[];
      returns?: readonly TextReturnedEvent[];
      childTransfer?: ChildResultTransfer;
      captureThread?: ThreadId;
      activity?: { item: ToolActivityHistoryItem; round: string | null };
    } = {},
  ) {
    if (!this.db.inTransaction) throw Error("Sync index must share the object write transaction");
    if (
      !extras.childTransfer &&
      !extras.activity &&
      !rows.length &&
      !extras.removed?.length &&
      !extras.returns?.length
    )
      return;
    const position = this.advanceClock();
    const put =
      this.db.query(`INSERT INTO sync_rows(source,key,round,created,changed,version,payload) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(source,key) DO UPDATE SET changed=excluded.changed,version=excluded.version,payload=excluded.payload,round=excluded.round`);
    const now = Date.now();
    for (const row of rows) {
      this.list.record(row, position, now);
      const source =
        row.objectType === "thread"
          ? row.value.id
          : "threadId" in row.value
            ? row.value.threadId
            : row.objectType === "checkpointCapture"
              ? extras.captureThread
              : null;
      if (!source) throw Error("Missing source thread");
      const round =
        row.objectType === "round"
          ? row.value.id
          : "roundId" in row.value
            ? row.value.roundId
            : null;
      put.run(
        source,
        keyString(rowKey(row)),
        round,
        row.objectType === "timelineItem" ? row.value.createdPosition : position,
        position,
        row.value.version,
        encodeJournalRow(row),
      );
    }
    if (extras.activity) {
      const { item, round } = extras.activity;
      this.list.touch(item.threadId, position, now);
      put.run(
        item.threadId,
        keyString(rowKey({ objectType: "timelineItem", value: item })),
        round,
        item.createdPosition,
        position,
        item.version,
        JSON.stringify(item.id),
      );
    }
    for (const item of extras.removed ?? []) {
      this.list.remove(item.source, item.key.objectType, item.key.id, position, now);
      const prior = this.db
        .query<{ version: string }, [string, string]>(
          "SELECT version FROM sync_rows WHERE source=? AND key=?",
        )
        .get(item.source, keyString(item.key));
      if (!prior || BigInt(item.version) <= BigInt(prior.version))
        throw Error("Invalid deletion version");
      this.db.run(
        "UPDATE sync_rows SET changed=?,version=?,payload=NULL WHERE source=? AND key=?",
        [position, item.version, item.source, keyString(item.key)],
      );
    }
    if (extras.childTransfer) {
      const transfer = extras.childTransfer;
      this.db.run(
        "INSERT INTO sync_child_returns VALUES(?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET changed=excluded.changed,data=excluded.data",
        [transfer.parentThreadId, transfer.id, position, JSON.stringify(transfer)],
      );
    }
    for (const event of extras.returns ?? [])
      this.db.run(
        "INSERT INTO sync_returns VALUES(?,?,?,?) ON CONFLICT(source,id) DO UPDATE SET changed=excluded.changed,data=excluded.data",
        [event.result.target.threadId, event.result.transferId, position, JSON.stringify(event)],
      );
  }
  recordToolActivity(event: ToolActivityEvent): "stored" | "unchanged" | "conflict" {
    let changed = false;
    const result = this.db
      .transaction(() => {
        const seen = this.activities.recordEvent(event);
        if (seen !== "new") return seen;
        if (event.observation) {
          const source = {
            instanceId: v.parse(ExecutorInstanceIdSchema, event.instanceId),
            nativeSessionId: v.parse(NativeSessionIdSchema, event.nativeSessionId),
            epoch: event.epoch,
            ...event.observation,
          };
          const relationship = event.relationship;
          if (!relationship) throw Error("Missing native observation relationship");
          changed = this.saveObservation(event.threadId, source, (prior) => {
            if (!prior) throw Error("Unknown observation source");
            const linked = promoteSessionObservation(prior, {
              kind: "attempt",
              source,
              relationship,
              attemptId: v.parse(AttemptIdSchema, event.attemptId),
            });
            if (linked.kind !== "ok") throw Error(linked.reason);
            return linked.value;
          });
        }
        const source = this.db
          .query<{ id: number; item_id: string }, [string, string, string, number, string, string]>(
            "SELECT id,item_id FROM tool_activity_sources WHERE thread_id=? AND instance_id=? AND session_id=? AND epoch=? AND call_id=? AND attempt_id=?",
          )
          .get(
            event.threadId,
            event.instanceId,
            event.nativeSessionId,
            event.epoch,
            event.callId,
            event.attemptId,
          );
        const id = source
          ? v.parse(TimelineItemIdSchema, source.item_id)
          : v.parse(TimelineItemIdSchema, crypto.randomUUID());
        const latest =
          source &&
          this.db
            .query<{ version: string }, [number]>(
              "SELECT version FROM tool_activity_versions WHERE source=? ORDER BY length(version) DESC,version DESC LIMIT 1",
            )
            .get(source.id);
        const stored = latest && this.activityTransfer(event.threadId, id, latest.version);
        const previous = stored ? { item: stored.item, body: this.activityBody(stored) } : null;
        const next = evolveToolActivity(previous, event, {
          id,
          createdPosition: this.nextPosition(),
        });

        if (!next.changed) return "unchanged";
        const call =
          source?.id ??
          Number(
            this.db.run(
              "INSERT INTO tool_activity_sources(thread_id,instance_id,session_id,epoch,call_id,attempt_id,item_id) VALUES(?,?,?,?,?,?,?)",
              [
                event.threadId,
                event.instanceId,
                event.nativeSessionId,
                event.epoch,
                event.callId,
                event.attemptId,
                next.item.id,
              ],
            ).lastInsertRowid,
          );
        this.activities.save(call, next.item, next.body);
        this.record([], { activity: { item: next.item, round: event.roundId ?? null } });
        changed = true;
        return "stored";
      })
      .immediate();
    if (changed) this.notify();
    return result;
  }
  recordUnattributedToolChange(event: {
    itemId?: string;
    threadId: ThreadId;
    attemptId: string;
    eventId: string;
    path: string;
    change: "created" | "modified" | "deleted" | "moved";
    destination: string | null;
    patch: string | null;
  }) {
    this.db.run("INSERT OR IGNORE INTO tool_activity_scoped_changes VALUES(?,?,?)", [
      event.threadId,
      event.eventId,
      JSON.stringify(event),
    ]);
  }
  activityTransfer(threadId: ThreadId, itemId: TimelineItemId, version: string) {
    return this.activities.transfer(threadId, itemId, version);
  }
  activityBody(stored: StoredToolActivityVersion) {
    const bytes = stored.read(0, stored.reference.byteLength);
    return v.parse(ToolActivityBodySchema, JSON.parse(Buffer.from(bytes).toString("utf8")).body);
  }
  readList(
    scope: ListScope,
    visibility: string,
    actor: PrincipalId,
    canRead: (id: ThreadId) => boolean,
    canAnswer: (todo: TodoRequest) => boolean,
  ) {
    return this.db.transaction(() => {
      const meta = this.meta();
      if (!meta) throw Error("Missing sync clock");
      const head = v.parse(SyncCursorSchema, {
        environmentId: this.environmentId,
        databaseGeneration: meta.generation,
        visibilityGeneration: visibility,
        scope,
        shapeVersion: 2,
        through: meta.head,
      });
      return this.list.read(
        head,
        v.parse(SyncPositionSchema, meta.floor),
        scope,
        actor,
        canRead,
        canAnswer,
      );
    })();
  }
  read(scope: AuthorizedScope, visibility: string): ThreadReadView {
    return this.db.transaction((): ThreadReadView => {
      const meta = this.meta();
      if (!meta) throw Error("Missing sync clock");
      const head = v.parse(SyncCursorSchema, {
        environmentId: this.environmentId,
        databaseGeneration: meta.generation,
        visibilityGeneration: visibility,
        scope: { kind: "thread", threadId: scope.threadId },
        shapeVersion:
          (scope.protocolMinor >= 1 ? 3 : 1) +
          Number(scope.timelineItems) +
          (scope.directoryDiff ? 4 : 0),
        through: meta.head,
      });
      const result: ThreadReadView = {
        head,
        floor: v.parse(SyncPositionSchema, meta.floor),
        rows: [],
        deletions: [],
        returns: [],
      };
      const rows: ReadRow[] = [],
        deletions: ThreadReadView["deletions"][number][] = [];
      const seen = new Set<string>();
      let source: ThreadId | undefined = scope.threadId;
      while (source && scope.canRead(source) && !seen.has(source)) {
        seen.add(source);
        let parent: ThreadId | undefined;
        for (const data of this.db
          .query<Entry, [string]>("SELECT * FROM sync_rows WHERE source=?")
          .all(source)) {
          const created = v.parse(SyncPositionSchema, data.created),
            changed = v.parse(SyncPositionSchema, data.changed);
          if (data.payload === null) {
            const tuple: unknown = JSON.parse(data.key);
            if (!Array.isArray(tuple)) throw Error("Damaged object key");
            const [objectType, a, b] = tuple;
            deletions.push({
              source,
              created,
              changed,
              key: v.parse(
                ObjectKeySchema,
                objectType === "timelineItem"
                  ? { objectType, threadId: a, id: b }
                  : { objectType, id: a },
              ),
              version: v.parse(ObjectVersionSchema, data.version),
            });
          } else {
            const payload: unknown = JSON.parse(data.payload);
            const row =
              typeof payload === "string"
                ? {
                    objectType: "timelineItem" as const,
                    value: this.activities.summary(source, payload, data.version),
                  }
                : decodeJournalRow(payload);
            if (row.objectType === "round")
              row.value = roundForProtocol(row.value, scope.protocolMinor);
            if (
              row.objectType === "checkpointCapture" &&
              !scope.directoryDiff &&
              row.value.result.kind === "ready" &&
              "directoryId" in row.value.result
            )
              row.value.result = { kind: "missing", reason: "directoryDiffUnsupported" };
            rows.push({ row, source, created, changed, round: data.round });
            if (row.objectType === "thread" && row.value.lineage.kind === "fork")
              parent = row.value.lineage.parentThreadId;
          }
        }
        source = parent;
      }
      const returns = scope.canRead(scope.threadId)
        ? this.db
            .query<{ data: string; changed: string }, [string]>(
              "SELECT data,changed FROM sync_returns WHERE source=?",
            )
            .all(scope.threadId)
            .map((r) => ({
              source: scope.threadId,
              changed: v.parse(SyncPositionSchema, r.changed),
              event: v.parse(TextReturnedEventSchema, JSON.parse(r.data)),
            }))
        : [];
      const childReturns = scope.canRead(scope.threadId)
        ? this.db
            .query<{ data: string; changed: string }, [string]>(
              "SELECT data,changed FROM sync_child_returns WHERE source=?",
            )
            .all(scope.threadId)
            .map((row) => ({
              source: scope.threadId,
              changed: v.parse(SyncPositionSchema, row.changed),
              event: {
                kind: "child.resultTransfer" as const,
                transfer: v.parse(ChildResultTransferSchema, JSON.parse(row.data)),
              },
            }))
        : [];
      return { ...result, rows, deletions, returns: [...returns, ...childReturns] };
    })();
  }
  history(
    scope: AuthorizedScope,
    visibility: string,
    principal: string,
    anchor: HistoryPage["anchor"] | null,
  ): HistoryPage | null {
    return this.db.transaction(() => {
      const view = this.read(scope, visibility);
      if (
        !scope.canRead(scope.threadId) ||
        !view.rows.some((r) => r.row.objectType === "thread" && r.source === scope.threadId)
      )
        return null;
      const visible = visibleThreadRows(scope, view).rows;
      const entries = historyEntries(visible);
      const captures = new Map(
        visible.flatMap(({ row }) =>
          row.objectType === "checkpointCapture" ? [[row.value.id, row] as const] : [],
        ),
      );
      const withCaptures = (items: ReadRow[]): HistoryRow[] =>
        items.reverse().flatMap(({ row }): HistoryRow[] => {
          const phase = row.objectType === "round" ? row.value.attempt.phase : null;
          const capture = phase?.kind === "finished" ? captures.get(phase.captureId) : undefined;
          return capture ? [row, capture] : [row];
        });
      const binding = JSON.stringify([
        principal,
        scope.environmentId,
        scope.threadId,
        visibility,
        view.head.databaseGeneration,
        view.head.shapeVersion,
      ]);
      const make = (rows: ReadRow[]) => {
        const id = v.parse(HistoryAnchorIdSchema, crypto.randomUUID());
        this.db.run("INSERT INTO sync_anchors VALUES(?,?,?,?)", [
          id,
          binding,
          rows[0] ? JSON.stringify(bound(rows[0])) : null,
          rows.at(-1) ? JSON.stringify(bound(rows[rows.length - 1]!)) : null,
        ]);
        return id;
      };
      let selected: ReadRow[];
      if (anchor) {
        const stored = this.db
          .query<{ high: string | null; low: string | null }, [string, string]>(
            "SELECT high,low FROM sync_anchors WHERE id=? AND binding=?",
          )
          .get(anchor, binding);
        if (!stored) return null;
        const hi = stored.high && v.parse(orderBound, JSON.parse(stored.high)),
          lo = stored.low && v.parse(orderBound, JSON.parse(stored.low));
        selected =
          hi && lo
            ? entries.filter((item) => orderBounded(item, hi) <= 0 && orderBounded(item, lo) >= 0)
            : [];
        const older = lo
          ? boundedEntries(entries.filter((item) => orderBounded(item, lo) < 0))
          : [];
        return {
          kind: "history.page" as const,
          threadId: scope.threadId,
          anchor,
          verifiedAt: view.head,
          pageNumber: 0,
          pageCount: 1,
          rows: withCaptures(selected),
          olderAnchor: older.length ? make(older) : null,
        };
      }
      const rest = entries.slice(boundedEntries(entries).length);
      selected = boundedEntries(rest);
      const older = boundedEntries(rest.slice(selected.length));
      return {
        kind: "history.page" as const,
        threadId: scope.threadId,
        anchor: make(selected),
        verifiedAt: view.head,
        pageNumber: 0,
        pageCount: 1,
        rows: withCaptures(selected),
        olderAnchor: older.length ? make(older) : null,
      };
    })();
  }
}
