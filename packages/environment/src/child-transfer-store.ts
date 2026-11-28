import * as v from "valibot";
import {
  ChildResultTransferSchema,
  DelegatedChildRecordSchema,
  MessageSchema,
  TodoRequestIdSchema,
  type ThreadId,
  type RoundId,
  type ChildResultTransfer,
  type DelegatedChildRecord,
  type MessageId,
} from "@kraka/protocol";
import type { ChildResultTransferStore } from "./executor-records";
import { prepareChildResultTransfer, transitionChildResultReturn } from "./child-results";
import { readMessage, readRound, type FirstSendStore } from "./first-send-store";

type TransferId = ChildResultTransfer["id"];
type TaskId = DelegatedChildRecord["taskId"];
type ReturnFacts = { transferId: TransferId; parentMessageId: MessageId; returnedAt: number };
type CommitEvent =
  | { kind: "childSettled"; taskId: TaskId; transferId: TransferId }
  | ({ kind: "parentMessageCommitted" | "returnCommitted" } & ReturnFacts);

export const childTables = `
CREATE TABLE IF NOT EXISTS delegated_children (
  task TEXT PRIMARY KEY, transfer TEXT NOT NULL UNIQUE, parent TEXT NOT NULL,
  command TEXT NOT NULL, data TEXT NOT NULL, UNIQUE(parent,command)
);
CREATE TABLE IF NOT EXISTS child_launches(parent TEXT NOT NULL,command TEXT NOT NULL,intent TEXT NOT NULL,owner TEXT NOT NULL,child TEXT UNIQUE,receipt TEXT NOT NULL,PRIMARY KEY(parent,command));
CREATE UNIQUE INDEX IF NOT EXISTS delegated_child_round ON delegated_children(json_extract(data,'$.childRoundId'));
CREATE TABLE IF NOT EXISTS child_result_transfers (
  id TEXT PRIMARY KEY, data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS pending_child_returns ON child_result_transfers(id)
  WHERE json_extract(data,'$.state.kind')='pending';
CREATE TABLE IF NOT EXISTS parent_result_messages (
  transfer TEXT PRIMARY KEY, message TEXT NOT NULL UNIQUE, returned_at INTEGER NOT NULL
);`;

export class ChildTransfers implements ChildResultTransferStore {
  beforeRecovery?: () => Promise<void>;
  afterCommit?: (event: CommitEvent) => void | Promise<void>;
  constructor(private readonly store: FirstSendStore) {}

  private child(task: TaskId) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM delegated_children WHERE task=?")
      .get(task);
    const parsed = row && v.safeParse(DelegatedChildRecordSchema, JSON.parse(row.data));
    return parsed?.success ? parsed.output : null;
  }

  private transfer(id: TransferId) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM child_result_transfers WHERE id=?")
      .get(id);
    const parsed = row && v.safeParse(ChildResultTransferSchema, JSON.parse(row.data));
    return parsed?.success ? parsed.output : null;
  }

  forParent(task: TaskId, parent: ThreadId) {
    const record = this.child(task);
    return record?.parentThreadId === parent ? record : null;
  }
  byRound(round: RoundId) {
    const row = this.store.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM delegated_children WHERE json_extract(data,'$.childRoundId')=?",
      )
      .get(round);
    const parsed = row && v.safeParse(DelegatedChildRecordSchema, JSON.parse(row.data));
    return parsed?.success ? parsed.output : null;
  }

  status(task: TaskId, parent: ThreadId) {
    const record = this.child(task);
    if (!record || record.parentThreadId !== parent) return null;
    let state = record.state;
    if (state.kind === "working" || state.kind === "queued" || state.kind === "waitingApproval") {
      const round = readRound(this.store.db, record.childRoundId);
      const phase = round?.attempt.phase;
      const pending = this.store.db
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM todo_requests WHERE json_extract(data,'$.roundId')=? AND json_extract(data,'$.threadId')=? AND json_extract(data,'$.body.kind')='approval' AND json_extract(data,'$.state.kind')='open' LIMIT 1",
        )
        .get(record.childRoundId, record.childThreadId);
      if (pending)
        state = {
          kind: "waitingApproval",
          roundId: record.childRoundId,
          requestId: v.parse(TodoRequestIdSchema, pending.id),
        };
      else if (phase?.kind === "endedEarly")
        state =
          phase.reason === "stopped"
            ? { kind: "cancelled" }
            : { kind: "failed", reason: phase.reason };
      else if (phase?.kind === "notDelivered") state = { kind: "failed", reason: phase.reason };
      else if (phase && phase.kind !== "filed") state = { kind: "working" };
    }
    return {
      taskId: task,
      childCommandId: record.childCommandId,
      threadId: record.childThreadId,
      state,
    };
  }
  cancelQueued(task: TaskId, parent: ThreadId) {
    const record = this.child(task);
    if (!record || record.parentThreadId !== parent || record.state.kind !== "queued") return false;
    const round = readRound(this.store.db, record.childRoundId);
    if (round?.attempt.phase.kind !== "filed") return false;
    this.store.setPhase(round, {
      kind: "notDelivered",
      reason: "Parent cancelled",
      lateReceipt: null,
    });
    this.store.db.run("UPDATE delegated_children SET data=? WHERE task=?", [
      JSON.stringify({ ...record, state: { kind: "cancelled" } }),
      task,
    ]);
    return true;
  }

  async read(task: TaskId) {
    return this.child(task);
  }
  async readTransfer(id: TransferId) {
    return this.transfer(id);
  }

  accept(record: DelegatedChildRecord): "stored" | "unchanged" | "conflict" {
    if (record.state.kind !== "queued") return "conflict";
    const { db } = this.store;
    return db
      .transaction(() => {
        const original = this.child(record.taskId);
        if (original)
          return Bun.deepEquals({ ...original, state: record.state }, record)
            ? "unchanged"
            : "conflict";
        if (
          readRound(db, record.parentRoundId)?.threadId !== record.parentThreadId ||
          readRound(db, record.childRoundId)?.threadId !== record.childThreadId
        )
          return "conflict";
        const write = db
          .query(
            "INSERT OR IGNORE INTO delegated_children(task,transfer,parent,command,data) VALUES(?,?,?,?,?)",
          )
          .run(
            record.taskId,
            record.returnTransferId,
            record.parentThreadId,
            record.childCommandId,
            JSON.stringify(record),
          );
        return write.changes ? "stored" : "conflict";
      })
      .immediate();
  }

  async settle(
    record: DelegatedChildRecord,
    transfer: ChildResultTransfer,
    finishRound?: () => void,
  ) {
    const prepared = prepareChildResultTransfer(record);
    if (prepared.kind !== "ok" || !Bun.deepEquals(prepared.value, transfer)) return "conflict";
    const { db } = this.store;
    const result = db
      .transaction(() => {
        const original = this.child(record.taskId);
        if (!original || !Bun.deepEquals({ ...original, state: record.state }, record))
          return "conflict";
        const existing = this.transfer(transfer.id);
        if (existing) {
          return Bun.deepEquals(original, record) &&
            Bun.deepEquals(
              { ...existing, state: transfer.state, version: transfer.version },
              transfer,
            )
            ? "unchanged"
            : "conflict";
        }
        if (
          original.state.kind === "completed" ||
          original.state.kind === "cancelled" ||
          original.state.kind === "failed"
        )
          return "conflict";
        finishRound?.();
        db.run("UPDATE delegated_children SET data=? WHERE task=?", [
          JSON.stringify(record),
          record.taskId,
        ]);
        db.run("INSERT INTO child_result_transfers VALUES(?,?)", [
          transfer.id,
          JSON.stringify(transfer),
        ]);
        this.store.sync.record([], { childTransfer: transfer });
        return "stored";
      })
      .immediate();
    if (result === "stored")
      await this.afterCommit?.({
        kind: "childSettled",
        taskId: record.taskId,
        transferId: transfer.id,
      });
    if (result === "stored") this.store.sync.notify();
    return result;
  }

  private parentMessage(transfer: ChildResultTransfer) {
    const row = this.store.db
      .query<{ message: string; returned_at: number }, [string]>(
        "SELECT message,returned_at FROM parent_result_messages WHERE transfer=?",
      )
      .get(transfer.id);
    if (!row) return null;
    const message = readMessage(this.store.db, row.message);
    if (
      !message ||
      message.threadId !== transfer.parentThreadId ||
      message.roundId !== transfer.parentRoundId ||
      message.text !== transfer.result
    )
      throw Error("Child return does not match its stored parent message");
    return { transferId: transfer.id, parentMessageId: message.id, returnedAt: row.returned_at };
  }

  async markReturned(
    id: TransferId,
    parentMessageId: MessageId,
    returnedAt: number,
    expectedVersion: ChildResultTransfer["version"],
  ) {
    const { db } = this.store;
    const event = { transferId: id, parentMessageId, returnedAt };
    const result = db
      .transaction(() => {
        const current = this.transfer(id);
        if (!current || !Bun.deepEquals(this.parentMessage(current), event)) return "conflict";
        const next = transitionChildResultReturn(current, event);
        if (next.kind !== "ok") return "conflict";
        if (current.state.kind === "returned")
          return expectedVersion === "1" || expectedVersion === current.version
            ? "unchanged"
            : "conflict";
        if (current.version !== expectedVersion) return "conflict";
        db.run("UPDATE child_result_transfers SET data=? WHERE id=?", [
          JSON.stringify(next.value),
          id,
        ]);
        this.store.sync.record([], { childTransfer: next.value });
        return "returned";
      })
      .immediate();
    if (result === "returned") {
      await this.afterCommit?.({ kind: "returnCommitted", ...event });
      this.store.sync.notify();
    }
    return result;
  }

  async returnToParent(id: TransferId) {
    const { db } = this.store;
    const evidence = db
      .transaction(() => {
        const transfer = this.transfer(id);
        if (!transfer) return null;
        const child = this.child(transfer.taskId);
        if (
          child?.state.kind !== "completed" ||
          child.returnTransferId !== transfer.id ||
          child.parentRoundId !== transfer.parentRoundId ||
          child.parentThreadId !== transfer.parentThreadId ||
          child.childRoundId !== transfer.childRoundId ||
          child.childThreadId !== transfer.childThreadId ||
          child.state.result !== transfer.result ||
          readRound(db, transfer.parentRoundId)?.threadId !== transfer.parentThreadId
        )
          return null;
        const prior = this.parentMessage(transfer);
        if (prior) return { facts: prior, inserted: false, version: transfer.version };
        if (transfer.state.kind !== "pending") return null;
        const message = v.parse(MessageSchema, {
          id: crypto.randomUUID(),
          threadId: transfer.parentThreadId,
          roundId: transfer.parentRoundId,
          author: { kind: "executor", id: child.instanceId },
          text: transfer.result,
          references: [],
          attachments: [],
          version: "1",
        });
        const facts = { transferId: id, parentMessageId: message.id, returnedAt: Date.now() };
        db.run("INSERT INTO messages VALUES(?,?)", [message.id, JSON.stringify(message)]);
        db.run("INSERT INTO parent_result_messages VALUES(?,?,?)", [
          id,
          message.id,
          facts.returnedAt,
        ]);
        this.store.sync.record([{ objectType: "message", value: message }]);
        return { facts, inserted: true, version: transfer.version };
      })
      .immediate();
    if (!evidence) return null;
    const { facts, inserted, version } = evidence;
    if (inserted) await this.afterCommit?.({ kind: "parentMessageCommitted", ...facts });
    const result = await this.markReturned(id, facts.parentMessageId, facts.returnedAt, version);
    return result === "conflict" ? null : this.transfer(id);
  }

  pending() {
    return this.store.db
      .query<{ id: string }, []>(
        "SELECT id FROM child_result_transfers WHERE json_extract(data,'$.state.kind')='pending' ORDER BY rowid",
      )
      .all()
      .map((row) => v.parse(ChildResultTransferSchema.entries.id, row.id));
  }
}
