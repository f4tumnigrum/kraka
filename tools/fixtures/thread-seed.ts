import * as v from "valibot";
import {
  HistoryPageSchema,
  type HistoryRow,
  type SignedRequest,
  type CommandReceipt,
  RoundSchema,
  RoundPhaseSchema,
  MessageSchema,
  SyncPositionSchema,
  ThreadIdSchema,
  RoundIdSchema,
  ToolActivityFileChangeSchema,
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
  if (request.method !== "input.send" || request.payload.threadId.toString() !== "thread-notes")
    return null;
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
const activity = v.strictObject({
  threadId: ThreadIdSchema,
  roundId: v.optional(RoundIdSchema),
  instanceId: v.string(),
  nativeSessionId: v.string(),
  epoch: v.number(),
  eventId: v.string(),
  callId: v.string(),
  attemptId: v.string(),
  nativeRootTurnId: v.string(),
  phase: v.picklist(["started", "progress", "ended"]),
  inputJson: v.nullable(v.string()),
  outputText: v.nullable(v.string()),
  exitCode: v.nullable(v.number()),
  at: v.number(),
  changes: v.optional(v.array(ToolActivityFileChangeSchema)),
});
const seedCommand = v.union([
  v.strictObject({ activity }),
  v.strictObject({
    unattributed: v.strictObject({
      ...ToolActivityFileChangeSchema.entries,
      threadId: ThreadIdSchema,
      eventId: v.string(),
      attemptId: v.string(),
    }),
  }),
  v.strictObject({ transactions: v.array(v.array(schema)) }),
  v.strictObject({ rows: v.array(schema) }),
  v.strictObject({ floor: SyncPositionSchema }),
  v.strictObject({ phase: RoundPhaseSchema }),
]);

export function serveSeed(store: FirstSendStore) {
  if (!process.send) throw Error("Seed writer requires a private IPC channel");
  const reply = process.send.bind(process);
  process.on("message", (message: unknown) => {
    const { id, command } = v.parse(v.object({ id: v.string(), command: v.unknown() }), message);
    let error: string | null = null;
    try {
      const op = v.parse(seedCommand, command);
      if ("activity" in op) {
        if (store.sync.recordToolActivity(op.activity) === "conflict")
          throw Error("Conflicting activity seed");
      } else if ("unattributed" in op) store.sync.recordUnattributedToolChange(op.unattributed);
      else if ("transactions" in op) {
        for (const rows of op.transactions) persist(store, rows);
      } else if ("rows" in op) persist(store, op.rows);
      else if ("floor" in op) store.db.run("UPDATE sync_meta SET floor=?", [op.floor]);
      else {
        const round = readRound(store.db, "round-heading");
        if (!round) throw Error("Missing test round");
        store.setPhase(round, op.phase);
      }
    } catch (e) {
      error = String(e);
    }
    reply({ id, error });
  });
  process.channel?.unref();
}
