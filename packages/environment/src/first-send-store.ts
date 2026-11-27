import { Database } from "bun:sqlite";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  RoundSchema,
  ThreadSchema,
  MessageSchema,
  ProjectSchema,
  DirectoryRecordSchema,
  type Thread,
  type Round,
  type CommandId,
  type PrincipalId,
  type DeliveryId,
  type RoundPhase,
  canonicalJson,
} from "@kraka/protocol";
import { DatabaseHeaderSchema, inspectDatabase, type DirectoryWriter } from "./migrations";
import { directoryForThread } from "./worktrees";
import { physicalDirectory } from "./project-directory";
import { recoverInputDelivery } from "./round";
import type { FrozenDelivery } from "./executor-records";

const catalog = { initial: 1, steps: [] };
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
export function openStore(writer: DirectoryWriter) {
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
    if (format === undefined || format > catalog.initial) throw new Error("futureFormat");
    const header = fresh
      ? { format: 1, ledger: [] }
      : JSON.parse(
          db.query<{ data: string }, []>("SELECT data FROM header WHERE id=1").get()?.data ??
            "null",
        );
    const compatibility = inspectDatabase(catalog, v.parse(DatabaseHeaderSchema, header));
    if (compatibility.kind !== "open")
      throw new Error(
        compatibility.kind === "refuse" ? compatibility.reason : "migration required",
      );
    if (!fresh && header.format !== format) throw new Error("invalidLedger");
    db.run("PRAGMA journal_mode=WAL");
    db.run("PRAGMA synchronous=FULL");
    if (fresh)
      db.transaction(() => {
        db.exec(ddl);
        db.run("PRAGMA user_version=1");
        db.run("INSERT INTO header VALUES(1,?)", [JSON.stringify(header)]);
      })();
    const store = new FirstSendStore(db, writer);
    db.transaction(() => {
      for (const { round } of db
        .query<{ round: string }, []>("SELECT round FROM deliveries WHERE pending=1")
        .all()) {
        const row = readRound(db, round);
        if (!row) throw new Error("Delivery missing round");
        store.setPhase(row, recoverInputDelivery(row.attempt.phase, "person", "none"));
      }
    })();
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
  beforeCommit?: (method: string) => void;
  constructor(
    readonly db: Database,
    readonly writer: DirectoryWriter,
  ) {}
  directory(thread: Thread) {
    const project = readProject(this.db, thread.projectId);
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
  setPhase(round: Round, phase: RoundPhase) {
    const updated = {
      ...round,
      version: String(BigInt(round.version) + 1n),
      attempt: { ...round.attempt, phase },
    };
    this.db.transaction(() => {
      this.db.run("UPDATE rounds SET data=? WHERE id=?", [JSON.stringify(updated), round.id]);
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
    return v.parse(RoundSchema, updated);
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
