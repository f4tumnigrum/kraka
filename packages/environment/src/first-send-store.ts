import { RoundCaptures } from "./capture-store";
import { TodoLedger } from "./todo-ledger";
import { ThreadJournal } from "./thread-journal";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import {
  type CommandId,
  type CheckpointCapture,
  CommandReceiptSchema,
  canonicalJson,
  type DeliveryId,
  DirectoryRecordSchema,
  MessageSchema,
  type PrincipalId,
  ProjectSchema,
  type Round,
  type RoundPhase,
  RoundSchema,
  type Thread,
  ThreadSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import type { FrozenDelivery } from "./executor-records";
import { type RecoveryScope, recoverQueues } from "./input-store";
import { DatabaseHeaderSchema, type DirectoryWriter, inspectDatabase } from "./migrations";
import { physicalDirectory } from "./project-directory";
import { directoryForThread } from "./worktrees";

import { worktreeTables, readManaged } from "./worktree-storage";
import { settingTables } from "./setting-store";
import { managedView } from "./worktree-git";
const step = v.parse(DatabaseHeaderSchema.entries.ledger.item, {
  id: "input-attempts",
  from: 1,
  to: 2,
});
const catalog = { initial: 1, steps: [step] };
const upgrade = `
ALTER TABLE deliveries RENAME TO first_deliveries;
DROP INDEX unfinished;
CREATE TABLE deliveries(id TEXT PRIMARY KEY, round TEXT NOT NULL, pending INTEGER NOT NULL, frozen TEXT);
INSERT INTO deliveries SELECT * FROM first_deliveries;
DROP TABLE first_deliveries;
CREATE INDEX unfinished ON deliveries(round) WHERE pending=1;
CREATE INDEX round_thread ON rounds(json_extract(data,'$.threadId'));
CREATE INDEX unfinished_thread ON rounds(json_extract(data,'$.threadId')) WHERE json_extract(data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered');
CREATE INDEX message_thread ON messages(json_extract(data,'$.threadId'));
CREATE TABLE queues(thread TEXT PRIMARY KEY,version TEXT NOT NULL);
CREATE TABLE input_decisions(actor TEXT NOT NULL, command TEXT NOT NULL, thread TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(actor,command));
CREATE TABLE input_guarantees(delivery TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE turn_work(round TEXT NOT NULL,kind TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(round,kind));
`;
const ddl = `
CREATE TABLE header (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);
CREATE TABLE receipts (position INTEGER PRIMARY KEY, actor TEXT NOT NULL, command TEXT NOT NULL, intent TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(actor, command));
CREATE TABLE projects (id TEXT PRIMARY KEY, environment TEXT NOT NULL, path TEXT NOT NULL, identity TEXT NOT NULL, data TEXT NOT NULL, directory TEXT NOT NULL, UNIQUE(environment,path));
CREATE TABLE threads (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE messages (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE rounds (id TEXT PRIMARY KEY, data TEXT NOT NULL, source TEXT NOT NULL);
CREATE TABLE deliveries (id TEXT PRIMARY KEY, round TEXT UNIQUE NOT NULL, pending INTEGER NOT NULL, frozen TEXT);
CREATE INDEX unfinished ON deliveries(round) WHERE pending=1;
`;
export function openStore(writer: DirectoryWriter, recovery?: RecoveryScope) {
  const db = new Database(join(writer.stateDirectory, "environment.sqlite"), {
    create: true,
    strict: true,
  });
  try {
    const tables = db
      .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const format = db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get()?.user_version;
    const fresh = tables.length === 0 && format === 0;
    if (format === undefined || format > step.to) throw new Error("futureFormat");
    const header = fresh
      ? { format: 1, ledger: [] }
      : JSON.parse(
          db.query<{ data: string }, []>("SELECT data FROM header WHERE id=1").get()?.data ??
            "null",
        );
    const compatibility = inspectDatabase(catalog, v.parse(DatabaseHeaderSchema, header));
    if (compatibility.kind === "refuse") throw new Error(compatibility.reason);
    if (!fresh && header.format !== format) throw new Error("invalidLedger");
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=FULL");
    if (fresh)
      db.transaction(() => {
        db.exec(ddl);
        db.run("PRAGMA user_version=1");
        db.run("INSERT INTO header VALUES(1,?)", [JSON.stringify(header)]);
      })();
    if (compatibility.kind === "migrationRequired")
      db.transaction(() => {
        db.exec(upgrade);
        db.run("UPDATE header SET data=? WHERE id=1", [
          JSON.stringify({ format: 2, ledger: [step] }),
        ]);
        db.run("PRAGMA user_version=2");
      })();
    db.exec(worktreeTables);
    db.exec(settingTables);
    const store = new FirstSendStore(db, writer);
    recoverQueues(store, recovery);
    return store;
  } catch (e) {
    db.close();
    throw e;
  }
}
export function openReceiptReader(stateDir: string) {
  return new Database(join(stateDir, "environment.sqlite"), { readonly: true, strict: true });
}
type Entity = "threads" | "rounds" | "messages" | "projects";
function readObject<S extends v.GenericSchema>(db: Database, table: Entity, id: string, schema: S) {
  const row = db.query<{ data: string }, [string]>(`SELECT data FROM ${table} WHERE id=?`).get(id);
  return row ? v.parse(schema, JSON.parse(row.data)) : null;
}
export const readThread = (db: Database, id: string) => readObject(db, "threads", id, ThreadSchema);
export const readMessage = (db: Database, id: string) =>
  readObject(db, "messages", id, MessageSchema);
export const readProject = (db: Database, id: string) =>
  readObject(db, "projects", id, ProjectSchema);
export function readRound(db: Database, id: string) {
  const round = readObject(db, "rounds", id, RoundSchema);
  const phase = round?.attempt.phase;
  if (phase && "endedAt" in phase && !phase.endTimeEvidence)
    phase.endTimeEvidence = {
      source: "unknown",
      executorEndedAt: null,
      environmentObservedAt: null,
    };
  if (round) {
    const history = round.attempts ?? [];
    round.attempts = [
      ...history.filter((a) => a.attemptId !== round.attempt.attemptId),
      {
        ...round.attempt,
        origin: history.find((a) => a.attemptId === round.attempt.attemptId)?.origin ?? {
          kind: "initial",
        },
      },
    ];
  }
  return round;
}
export function readReceipt(db: Database, actor: PrincipalId, command: CommandId) {
  const row = db
    .query<{ position: string; intent: string; data: string }, [string, string]>(
      "SELECT CAST(position AS TEXT) position,intent,data FROM receipts WHERE actor=? AND command=?",
    )
    .get(actor, command);
  return row
    ? {
        position: row.position,
        intent: row.intent,
        receipt: v.parse(CommandReceiptSchema, JSON.parse(row.data)),
      }
    : null;
}
export class FirstSendStore {
  readonly sync: ThreadJournal;
  readonly captures: RoundCaptures;
  readonly todos: TodoLedger;
  onQueueChanged?: (thread: Thread["id"]) => void;
  beforeCommit?: (method: string) => void;
  constructor(
    readonly db: Database,
    readonly writer: DirectoryWriter,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS codex_bindings(thread TEXT NOT NULL,epoch INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,epoch)); CREATE TABLE IF NOT EXISTS round_stops(thread TEXT NOT NULL,command TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,command));",
    );
    this.sync = new ThreadJournal(db, writer.environmentId);
    this.todos = new TodoLedger(this);
    this.captures = new RoundCaptures(this);
  }
  projectDirectory(id: string) {
    const row = this.db
      .query<{ path: string; identity: string }, [string, string]>(
        "SELECT path,identity FROM projects WHERE id=? AND environment=?",
      )
      .get(id, this.writer.environmentId);
    const physical = row ? physicalDirectory(row.path) : null;
    return physical && physical.identity === row?.identity && physical.realPath === row.path
      ? physical.realPath
      : null;
  }
  directory(thread: Thread) {
    const project = readProject(this.db, thread.projectId);
    if (thread.worktreeId && project) {
      const managed = readManaged(this.db, thread.worktreeId);
      return managed
        ? directoryForThread(thread, project, managed.directory, managedView(managed))
        : null;
    }
    const saved = this.db
      .query<{ identity: string; directory: string }, [string]>(
        "SELECT identity,directory FROM projects WHERE id=?",
      )
      .get(thread.projectId);
    if (!project || !saved || project.environmentId !== this.writer.environmentId) return null;
    const record = v.parse(DirectoryRecordSchema, JSON.parse(saved.directory));
    const path = directoryForThread(thread, project, record, null);
    const physical = path ? physicalDirectory(path) : null;
    return physical?.identity === saved.identity && physical.realPath === path ? path : null;
  }
  setPhase(round: Round, phase: RoundPhase, capture?: CheckpointCapture) {
    if (phase.kind === "filed" && phase.gate === "eligible") {
      const thread = readThread(this.db, round.threadId);
      if (thread?.worktreeId) {
        const managed = readManaged(this.db, thread.worktreeId);
        if (
          !managed ||
          (managed.roundId === round.id && managed.claim.operationId !== managed.firstCommand) ||
          !this.directory(thread)
        )
          phase = { kind: "filed", gate: "held" };
      }
    }
    const updated = {
      ...round,
      version: String(BigInt(round.version) + 1n),
      attempt: { ...round.attempt, phase },
    };
    if (updated.attempts)
      updated.attempts = updated.attempts.map((a) =>
        a.attemptId === updated.attempt.attemptId ? { ...a, phase } : a,
      );
    const saved = v.parse(RoundSchema, updated);
    this.db.transaction(() => {
      this.sync.record(
        [
          { objectType: "round", value: saved },
          ...(capture ? [{ objectType: "checkpointCapture" as const, value: capture }] : []),
        ],
        { captureThread: round.threadId },
      );
      this.db.run("UPDATE rounds SET data=? WHERE id=?", [JSON.stringify(saved), round.id]);
      if (phase.kind === "finished" || phase.kind === "endedEarly" || phase.kind === "notDelivered")
        this.db.run("DELETE FROM capture_intents WHERE round=? AND attempt=?", [
          round.id,
          saved.attempt.attemptId,
        ]);
      if (phase.kind !== "filed" || phase.gate !== "eligible")
        this.db.run("DELETE FROM ready_dispatch WHERE round=?", [round.id]);
      const pending =
        phase.kind === "armed" ||
        phase.kind === "handed" ||
        phase.kind === "working" ||
        phase.kind === "received" ||
        phase.kind === "recovering" ||
        (phase.kind === "filed" && phase.gate === "eligible");
      this.db.run("UPDATE deliveries SET pending=? WHERE id=?", [
        Number(pending),
        round.attempt.deliveryId,
      ]);
    })();
    this.sync.notify();
    return saved;
  }
  freeze(delivery: FrozenDelivery) {
    const bytes = canonicalJson(delivery);
    const row = this.db
      .query<{ frozen: string | null }, [string]>("SELECT frozen FROM deliveries WHERE id=?")
      .get(delivery.deliveryId);
    if (!row) throw new Error("Unknown delivery");
    if (row.frozen !== null) return row.frozen === bytes ? "unchanged" : "conflict";
    this.db.run("UPDATE deliveries SET frozen=? WHERE id=?", [bytes, delivery.deliveryId]);
    return "stored";
  }
  frozen(id: DeliveryId): unknown {
    const row = this.db
      .query<{ frozen: string | null }, [string]>("SELECT frozen FROM deliveries WHERE id=?")
      .get(id);
    return row?.frozen ? JSON.parse(row.frozen) : null;
  }
}
