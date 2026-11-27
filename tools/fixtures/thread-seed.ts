import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  HistoryPageSchema,
  type HistoryRow,
  type SignedRequest,
  type CommandReceipt,
  RoundSchema,
  MessageSchema,
  SyncPositionSchema,
} from "@kraka/protocol";
import { type FirstSendStore, readRound } from "@kraka/environment";
const schema = HistoryPageSchema.entries.rows.item;
function persist(store: FirstSendStore, rows: HistoryRow[]) {
  store.db.transaction(() => {
    for (const row of rows) {
      if (
        row.objectType === "thread" ||
        row.objectType === "message" ||
        row.objectType === "round"
      ) {
        const table =
          row.objectType === "thread"
            ? "threads"
            : row.objectType === "round"
              ? "rounds"
              : "messages";
        store.db.run(
          `INSERT INTO ${table} VALUES(?,?${table === "rounds" ? ",'person'" : ""}) ON CONFLICT(id) DO UPDATE SET data=excluded.data`,
          [row.value.id, JSON.stringify(row.value)],
        );
      }
    }
    store.sync.record(rows);
  })();
  store.sync.notify();
}
export function scenarioInput(
  request: SignedRequest,
  store: FirstSendStore,
): CommandReceipt | null {
  if (request.method !== "input.send") return null;
  const { threadId, content } = request.payload;
  const message = v.parse(MessageSchema, {
    ...content,
    id: "message-heading",
    threadId,
    roundId: "round-heading",
    author: { kind: "person", id: "person-lee" },
    version: "2",
  });
  const round = v.parse(RoundSchema, {
    id: "round-heading",
    threadId,
    messageId: message.id,
    place: "1",
    version: "2",
    attempt: {
      attemptId: "attempt-round-heading",
      deliveryId: "delivery-round-heading",
      phase: { kind: "filed", gate: "eligible" },
    },
  });
  persist(store, [
    { objectType: "message", value: message },
    { objectType: "round", value: round },
  ]);
  return {
    kind: "accepted",
    commandId: request.commandId,
    result: {
      kind: "inputScheduled",
      messageId: message.id,
      roundId: round.id,
      attemptId: round.attempt.attemptId,
      deliveryId: round.attempt.deliveryId,
    },
  };
}
export function serveSeed(store: FirstSendStore, dir: string) {
  const path = join(dir, "sync-command.json"),
    ack = join(dir, "sync-result.json");
  let last = "";
  const file = watch(dir, (_event, name) => {
    if (String(name) !== "sync-command.json" || !existsSync(path)) return;
    const { id, rows, transactions, floor, phase } = JSON.parse(readFileSync(path, "utf8"));
    if (id === last) return;
    last = id;
    let error: string | null = null;
    try {
      if (transactions)
        for (const batch of v.parse(v.array(v.array(schema)), transactions)) persist(store, batch);
      if (rows) persist(store, v.parse(v.array(schema), rows));
      if (floor) store.db.run("UPDATE sync_meta SET floor=?", [v.parse(SyncPositionSchema, floor)]);
      if (phase) {
        const r = readRound(store.db, "round-heading");
        if (!r) throw Error("Missing test round");
        store.setPhase(
          r,
          v.parse(RoundSchema, { ...r, attempt: { ...r.attempt, phase } }).attempt.phase,
        );
      }
    } catch (e) {
      error = String(e);
    }
    writeFileSync(ack + ".tmp", JSON.stringify({ id, error }));
    renameSync(ack + ".tmp", ack);
  });
  file.unref();
}
