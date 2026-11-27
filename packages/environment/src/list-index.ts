import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  ThreadSchema,
  TodoRequestSchema,
  AttentionFactsSchema,
  ObjectVersionSchema,
  SyncPositionSchema,
  HistoryPageSchema,
  type HistoryRow,
  type ThreadId,
  type PrincipalId,
  type ThreadLifecycle,
  type SyncCursor,
  type TodoRequest,
  type AttentionFacts,
} from "@kraka/protocol";
import type { ListScope, ListSource, ListView } from "./list-pass";

const active: ThreadLifecycle = {
  archivedAt: null,
  state: {
    kind: "active",
    pinnedAt: null,
    pinPosition: null,
    manualPosition: null,
    snoozedUntil: null,
  },
};
type RoundData = AttentionFacts["root"]["rounds"][number];
const roundFact = AttentionFactsSchema.entries.root.entries.rounds.item;
export class ListIndex {
  constructor(private db: Database) {
    const existing = db.query("SELECT 1 FROM sqlite_master WHERE name='list_sources'").get();
    db.exec(`CREATE TABLE IF NOT EXISTS list_sources(source TEXT PRIMARY KEY,changed TEXT NOT NULL,created_at INTEGER NOT NULL,activity_at INTEGER NOT NULL,thread TEXT);
    CREATE TABLE IF NOT EXISTS list_attempts(source TEXT NOT NULL,round TEXT NOT NULL,attempt TEXT NOT NULL,data TEXT NOT NULL,terminal INTEGER NOT NULL,PRIMARY KEY(source,round,attempt));
    CREATE TABLE IF NOT EXISTS list_watermarks(owner TEXT NOT NULL,source TEXT NOT NULL,position TEXT NOT NULL,PRIMARY KEY(owner,source));`);
    if (!existing) {
      const rows = db
        .query<{ source: string; created: string; changed: string; payload: string }, []>(
          `SELECT source,created,changed,payload FROM sync_rows WHERE payload IS NOT NULL ORDER BY length(changed),changed`,
        )
        .all();
      for (const row of rows)
        this.record(
          v.parse(HistoryPageSchema.entries.rows.item, JSON.parse(row.payload)),
          row.changed,
          0,
        );
    }
  }
  touch(source: string, position: string, now: number) {
    this.db
      .query(
        `INSERT INTO list_sources VALUES(?,?,?,?,NULL) ON CONFLICT(source) DO UPDATE SET changed=excluded.changed,activity_at=excluded.activity_at`,
      )
      .run(source, position, now, now);
  }
  record(row: HistoryRow, position: string, now: number) {
    const source =
      row.objectType === "thread"
        ? row.value.id
        : "threadId" in row.value
          ? row.value.threadId
          : null;
    if (!source) return;
    this.touch(source, position, now);
    if (row.objectType === "thread")
      this.db
        .query("UPDATE list_sources SET thread=? WHERE source=?")
        .run(JSON.stringify(row.value), source);
    if (row.objectType !== "round") return;
    const { id, attempt } = row.value;
    const terminal =
      attempt.phase.kind === "finished" ||
      attempt.phase.kind === "endedEarly" ||
      attempt.phase.kind === "notDelivered";
    const lifecycle = this.db
      .query<{ thread: string | null }, [string]>("SELECT thread FROM list_sources WHERE source=?")
      .get(source)?.thread;
    const state = lifecycle && JSON.parse(lifecycle).lifecycle?.state;
    const fact: RoundData = {
      round: { id, attempt },
      changedAt: v.parse(SyncPositionSchema, position),
      quota: null,
      review:
        attempt.phase.kind === "finished"
          ? {
              kind: "work",
              deferredAtEnd:
                state?.kind === "active" &&
                state.snoozedUntil !== null &&
                state.snoozedUntil > attempt.phase.endedAt,
            }
          : null,
    };
    this.db
      .query(
        `INSERT INTO list_attempts VALUES(?,?,?,?,?) ON CONFLICT(source,round,attempt) DO UPDATE SET data=excluded.data,terminal=excluded.terminal WHERE list_attempts.terminal=0`,
      )
      .run(source, id, attempt.attemptId, JSON.stringify(fact), Number(terminal));
  }
  remove(source: ThreadId, type: string, id: string, position: string, now: number) {
    this.touch(source, position, now);
    if (type === "thread")
      this.db.query("UPDATE list_sources SET thread=NULL WHERE source=?").run(source);
    if (type === "round")
      this.db.query("DELETE FROM list_attempts WHERE source=? AND round=?").run(source, id);
  }
  read(
    head: SyncCursor,
    floor: ListView["floor"],
    scope: ListScope,
    actor: PrincipalId,
    canRead: (id: ThreadId) => boolean,
    canAnswer: (todo: TodoRequest) => boolean,
  ): ListView {
    const sources = new Map<ThreadId, ListSource>(),
      todos = new Map<string, TodoRequest>();
    const rows = this.db
      .query<
        {
          source: ThreadId;
          thread: string;
          changed: string;
          created_at: number;
          activity_at: number;
          watermark: string | null;
        },
        [string, string | null, string | null]
      >(
        `SELECT s.*,w.position watermark FROM list_sources s LEFT JOIN list_watermarks w ON s.source=w.source AND w.owner=? WHERE s.thread IS NOT NULL AND (? IS NULL OR json_extract(s.thread,'$.projectId')=?)`,
      )
      .all(actor, scope.projectId, scope.projectId);
    for (const row of rows) {
      if (!canRead(row.source)) continue;
      const thread = v.parse(ThreadSchema, JSON.parse(row.thread));
      const lifecycle = thread.lifecycle ?? active;
      const summary = {
        threadId: thread.id,
        projectId: thread.projectId,
        parentThreadId: thread.lineage.kind === "root" ? null : thread.lineage.parentThreadId,
        version: v.parse(ObjectVersionSchema, row.changed),
        title: thread.title,
        createdAt: row.created_at,
        lastActivityAt: row.activity_at,
        lifecycle,
        openTodos: 0,
        activeRounds: 0,
      };
      sources.set(thread.id, {
        summary,
        facts: {
          threadId: thread.id,
          readThrough: row.watermark === null ? null : v.parse(SyncPositionSchema, row.watermark),
          grouping:
            lifecycle.archivedAt !== null
              ? "archived"
              : lifecycle.state.kind === "settled"
                ? "settled"
                : "ordinary",
          requests: [],
          rounds: [],
        },
      });
    }
    for (const s of sources.values())
      if (s.summary.parentThreadId && !sources.has(s.summary.parentThreadId))
        s.summary.parentThreadId = null;
    for (const row of this.db
      .query<{ source: ThreadId; created: string; payload: string }, []>(
        `SELECT source,created,payload FROM sync_rows WHERE payload IS NOT NULL AND json_extract(key,'$[0]')='todoRequest'`,
      )
      .all()) {
      const source = sources.get(row.source);
      if (!source) continue;
      const todo = v.parse(TodoRequestSchema, JSON.parse(row.payload).value);
      todos.set(todo.id, todo);
      if (todo.state.kind === "open") source.summary.openTodos++;
      source.facts.requests.push({
        request: { id: todo.id, body: todo.body, state: todo.state },
        openedAt: v.parse(SyncPositionSchema, row.created),
        answerable: todo.state.kind === "open" && canAnswer(todo),
      });
    }
    for (const row of this.db
      .query<{ source: ThreadId; data: string; terminal: number }, []>(
        "SELECT source,data,terminal FROM list_attempts",
      )
      .all()) {
      const source = sources.get(row.source);
      if (!source) continue;
      source.facts.rounds.push(v.parse(roundFact, JSON.parse(row.data)));
      if (!row.terminal) source.summary.activeRounds++;
    }
    return { head, floor, sources, todos };
  }
}
