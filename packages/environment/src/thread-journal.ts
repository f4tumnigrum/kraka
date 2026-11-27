import type { Database } from "bun:sqlite";
import { promoteSessionObservation } from "./session-observations";
import { AttemptIdSchema, ExecutorInstanceIdSchema, NativeSessionIdSchema } from "@kraka/protocol";
import { createHash } from "node:crypto";
import * as v from "valibot";
import {
  TRANSPORT_LIMITS,
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
  ToolActivityHistoryItemSchema,
  ToolActivityReferenceSchema,
  TextReturnedEventSchema,
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
  constructor(
    readonly db: Database,
    readonly environmentId: EnvironmentId,
  ) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS sync_meta(id INTEGER PRIMARY KEY CHECK(id=1),generation TEXT NOT NULL,head TEXT NOT NULL,floor TEXT NOT NULL);
     CREATE TABLE IF NOT EXISTS sync_rows(source TEXT NOT NULL,key TEXT NOT NULL,round TEXT,created TEXT NOT NULL,changed TEXT NOT NULL,version TEXT NOT NULL,payload TEXT,PRIMARY KEY(source,key));
     CREATE TABLE IF NOT EXISTS sync_returns(source TEXT NOT NULL,id TEXT NOT NULL,changed TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(source,id));
     CREATE TABLE IF NOT EXISTS sync_anchors(id TEXT PRIMARY KEY,binding TEXT NOT NULL,high TEXT,low TEXT);
     CREATE TABLE IF NOT EXISTS tool_activity_sources(thread_id TEXT NOT NULL,instance_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch INTEGER NOT NULL,call_id TEXT NOT NULL,attempt_id TEXT NOT NULL,item_id TEXT NOT NULL,PRIMARY KEY(thread_id,instance_id,session_id,epoch,call_id,attempt_id));
     CREATE TABLE IF NOT EXISTS tool_activity_events(thread_id TEXT NOT NULL,instance_id TEXT NOT NULL,session_id TEXT NOT NULL,epoch INTEGER NOT NULL,attempt_id TEXT NOT NULL,event_id TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(thread_id,instance_id,session_id,epoch,attempt_id,event_id));
     CREATE TABLE IF NOT EXISTS tool_activity_versions(thread_id TEXT NOT NULL,item_id TEXT NOT NULL,version TEXT NOT NULL,summary TEXT NOT NULL,byte_length INTEGER NOT NULL,sha256 TEXT NOT NULL,PRIMARY KEY(thread_id,item_id,version));
     CREATE TABLE IF NOT EXISTS tool_activity_blocks(digest TEXT NOT NULL,part INTEGER NOT NULL,data BLOB NOT NULL, PRIMARY KEY(digest,part));
     CREATE TABLE IF NOT EXISTS tool_activity_scoped_changes(thread_id TEXT NOT NULL,event_id TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread_id,event_id));`);
      if (this.meta()) return;
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
      if (rows.length) this.record(rows);
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
  notify() {
    for (const wake of this.listeners) wake();
  }
  record(
    rows: readonly HistoryRow[],
    extras: {
      removed?: readonly { source: ThreadId; key: ObjectKey; version: string }[];
      returns?: readonly TextReturnedEvent[];
    } = {},
  ) {
    if (!this.db.inTransaction) throw Error("Sync index must share the object write transaction");
    if (!rows.length && !extras.removed?.length && !extras.returns?.length) return;
    const meta = this.meta();
    if (!meta) throw Error("Missing sync clock");
    const position = String(BigInt(meta.head) + 1n);
    this.db.run("UPDATE sync_meta SET head=? WHERE id=1", [position]);
    const put =
      this.db.query(`INSERT INTO sync_rows(source,key,round,created,changed,version,payload) VALUES(?,?,?,?,?,?,?)
   ON CONFLICT(source,key) DO UPDATE SET changed=excluded.changed,version=excluded.version,payload=excluded.payload,round=excluded.round`);
    for (const row of rows) {
      const source =
        row.objectType === "thread"
          ? row.value.id
          : "threadId" in row.value
            ? row.value.threadId
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
        JSON.stringify(row),
      );
    }
    for (const item of extras.removed ?? []) {
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
        const { at: _at, ...fact } = event;
        const eventPayload = createHash("sha256").update(JSON.stringify(fact)).digest("hex");
        const priorEvent = this.db
          .query<{ payload: string }, [string, string, string, number, string, string]>(
            "SELECT payload FROM tool_activity_events WHERE thread_id=? AND instance_id=? AND session_id=? AND epoch=? AND attempt_id=? AND event_id=?",
          )
          .get(
            event.threadId,
            event.instanceId,
            event.nativeSessionId,
            event.epoch,
            event.attemptId,
            event.eventId,
          );
        if (priorEvent) return priorEvent.payload === eventPayload ? "unchanged" : "conflict";

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
          .query<{ item_id: string }, [string, string, string, number, string, string]>(
            "SELECT item_id FROM tool_activity_sources WHERE thread_id=? AND instance_id=? AND session_id=? AND epoch=? AND call_id=? AND attempt_id=?",
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
            .query<{ version: string }, [string, string]>(
              "SELECT version FROM tool_activity_versions WHERE thread_id=? AND item_id=? ORDER BY length(version) DESC,version DESC LIMIT 1",
            )
            .get(event.threadId, id);
        const stored = latest && this.activityTransfer(event.threadId, id, latest.version);
        const previous = stored ? { item: stored.item, body: this.activityBody(stored) } : null;
        const meta = this.meta();
        if (!meta) throw Error("Missing sync clock");
        const next = evolveToolActivity(previous, event, {
          id,
          createdPosition: v.parse(SyncPositionSchema, String(BigInt(meta.head) + 1n)),
        });

        this.db.run("INSERT INTO tool_activity_events VALUES(?,?,?,?,?,?,?)", [
          event.threadId,
          event.instanceId,
          event.nativeSessionId,
          event.epoch,
          event.attemptId,
          event.eventId,
          eventPayload,
        ]);
        if (!next.changed) return "unchanged";

        const bodyBytes = Buffer.from(JSON.stringify({ item: next.item, body: next.body }), "utf8");
        const sha256 = createHash("sha256").update(bodyBytes).digest("hex");
        const reference = v.parse(ToolActivityReferenceSchema, {
          threadId: event.threadId,
          itemId: next.item.id,
          version: next.item.version,
          byteLength: bodyBytes.length,
          sha256,
        });
        const blockSize = TRANSPORT_LIMITS.initialFlowWindowBytes;
        const insert = this.db.query("INSERT INTO tool_activity_blocks VALUES(?,?,?)");
        for (let offset = 0; offset < bodyBytes.length; offset += blockSize)
          insert.run(
            reference.sha256,
            offset / blockSize,
            bodyBytes.subarray(offset, offset + blockSize),
          );
        this.db.run("INSERT INTO tool_activity_versions VALUES(?,?,?,?,?,?)", [
          event.threadId,
          next.item.id,
          next.item.version,
          JSON.stringify(next.item),
          reference.byteLength,
          reference.sha256,
        ]);
        if (!source)
          this.db.run("INSERT INTO tool_activity_sources VALUES(?,?,?,?,?,?,?)", [
            event.threadId,
            event.instanceId,
            event.nativeSessionId,
            event.epoch,
            event.callId,
            event.attemptId,
            next.item.id,
          ]);
        this.record([{ objectType: "timelineItem", value: next.item }]);
        if (event.roundId)
          this.db.run("UPDATE sync_rows SET round=? WHERE source=? AND key=?", [
            event.roundId,
            event.threadId,
            keyString(rowKey({ objectType: "timelineItem", value: next.item })),
          ]);
        changed = true;
        return "stored";
      })
      .immediate();
    if (changed) this.notify();
    return result;
  }
  recordUnattributedToolChange(event: {
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
  activityTransfer(
    threadId: ThreadId,
    itemId: TimelineItemId,
    version: string,
  ): StoredToolActivityVersion | null {
    const row = this.db
      .query<{ summary: string; byte_length: number; sha256: string }, [string, string, string]>(
        "SELECT summary,byte_length,sha256 FROM tool_activity_versions WHERE thread_id=? AND item_id=? AND version=?",
      )
      .get(threadId, itemId, version);
    if (!row) return null;
    const item = v.parse(ToolActivityHistoryItemSchema, JSON.parse(row.summary));
    const reference = v.parse(ToolActivityReferenceSchema, {
      threadId,
      itemId,
      version,
      byteLength: row.byte_length,
      sha256: row.sha256,
    });
    const blockSize = TRANSPORT_LIMITS.initialFlowWindowBytes;
    const get = this.db.query<{ data: Uint8Array }, [string, number]>(
      "SELECT data FROM tool_activity_blocks WHERE digest=? AND part=?",
    );
    let block: Uint8Array = new Uint8Array(0),
      loaded = -1;
    return {
      item,
      reference,
      read(start, length) {
        const result = new Uint8Array(length);
        for (let written = 0; written < length; ) {
          const offset = start + written,
            part = Math.floor(offset / blockSize);
          if (part !== loaded) {
            const found = get.get(row.sha256, part);
            if (!found) throw Error("Missing activity body block");
            block = found.data;
            loaded = part;
          }
          const from = offset % blockSize,
            n = Math.min(block.length - from, length - written);
          if (n <= 0) throw Error("Incomplete activity body block");
          result.set(block.subarray(from, from + n), written);
          written += n;
        }
        return result;
      },
    };
  }
  activityBody(stored: StoredToolActivityVersion) {
    const bytes = stored.read(0, stored.reference.byteLength);
    return v.parse(ToolActivityBodySchema, JSON.parse(Buffer.from(bytes).toString("utf8")).body);
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
        shapeVersion: (scope.protocolMinor >= 1 ? 3 : 1) + Number(scope.timelineItems),
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
            const row = v.parse(rowSchema, JSON.parse(data.payload));
            if (row.objectType === "round")
              row.value = roundForProtocol(row.value, scope.protocolMinor);
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
      return { ...result, rows, deletions, returns };
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
      const entries = historyEntries(visibleThreadRows(scope, view).rows);
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
          rows: selected.reverse().map((r) => r.row),
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
        rows: selected.reverse().map((r) => r.row),
        olderAnchor: older.length ? make(older) : null,
      };
    })();
  }
}
