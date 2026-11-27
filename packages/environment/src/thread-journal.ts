import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  HistoryPageSchema,
  HistoryAnchorIdSchema,
  ObjectKeySchema,
  ObjectVersionSchema,
  SyncCursorSchema,
  SyncPositionSchema,
  ThreadIdSchema,
  TextReturnedEventSchema,
  keyString,
  rowKey,
  type HistoryPage,
  type HistoryRow,
  type ObjectKey,
  type ThreadId,
  type EnvironmentId,
  type TextReturnedEvent,
} from "@kraka/protocol";
import {
  boundedEntries,
  historyEntries,
  visibleThreadRows,
  type ThreadReadView,
  type AuthorizedScope,
  type ReadRow,
} from "./thread-pass";

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
     CREATE TABLE IF NOT EXISTS sync_anchors(id TEXT PRIMARY KEY,binding TEXT NOT NULL,high TEXT,low TEXT);`);
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
  read(scope: AuthorizedScope, visibility: string): ThreadReadView {
    return this.db.transaction((): ThreadReadView => {
      const meta = this.meta();
      if (!meta) throw Error("Missing sync clock");
      const head = v.parse(SyncCursorSchema, {
        environmentId: this.environmentId,
        databaseGeneration: meta.generation,
        visibilityGeneration: visibility,
        scope: { kind: "thread", threadId: scope.threadId },
        shapeVersion: scope.timelineItems ? 2 : 1,
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
