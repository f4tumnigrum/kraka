import * as v from "valibot";
import {
  TextReturnedEventSchema,
  HistoryPageSchema,
  type HistoryRow,
  type SignedRequest,
  type CommandReceipt,
  RoundSchema,
  RoundPhaseSchema,
  MessageSchema,
  SyncPositionSchema,
} from "@kraka/protocol";
import { seedRound, round as requestRound, todoFor, choices, native } from "./todo";
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
const seedCommand = v.union([
  v.strictObject({ transactions: v.array(v.array(schema)) }),
  v.strictObject({ rows: v.array(schema) }),
  v.strictObject({ floor: SyncPositionSchema }),
  v.strictObject({ phase: RoundPhaseSchema }),
  v.strictObject({ requests: v.literal("prepare") }),
  v.strictObject({ offer: v.picklist(["approval", "question"]) }),
  v.strictObject({ lose: v.picklist(["approval", "question"]) }),
  v.strictObject({
    round: v.string(),
    quota: v.nullable(v.object({ resetAt: v.nullable(v.number()) })),
  }),
  v.strictObject({ returned: TextReturnedEventSchema }),
]);

export function serveSeed(store: FirstSendStore) {
  if (!process.send) throw Error("Seed writer requires a private IPC channel");
  const reply = process.send.bind(process);
  const callbacks = new Map<string, ReturnType<typeof store.todos.open>>();
  process.on("message", (message: unknown) => {
    const { id, command } = v.parse(v.object({ id: v.string(), command: v.unknown() }), message);
    let error: string | null = null;
    try {
      const op = v.parse(seedCommand, command);
      if ("transactions" in op) {
        for (const rows of op.transactions) persist(store, rows);
      } else if ("rows" in op) persist(store, op.rows);
      else if ("floor" in op) store.db.run("UPDATE sync_meta SET floor=?", [op.floor]);
      else if ("requests" in op) {
        seedRound(store);
        store.setPhase(requestRound, { kind: "filed", gate: "eligible" });
      } else if ("offer" in op) {
        const round = readRound(store.db, requestRound.id);
        if (!round) throw Error("Missing request source");
        if (round.attempt.phase.kind === "filed") store.setPhase(round, requestRound.attempt.phase);
        callbacks.set(
          op.offer,
          store.todos.open(todoFor(op.offer), {
            ...native,
            attemptId: round.attempt.attemptId,
            ...(op.offer === "approval"
              ? { approval: { permission: "term.input" as const, choices } }
              : {}),
            async send(answer) {
              return answer.deliveryId;
            },
          }),
        );
      } else if ("lose" in op) callbacks.get(op.lose)?.close();
      else if ("quota" in op) {
        const round = readRound(store.db, op.round);
        if (!round) throw Error("Missing quota attempt");
        store.sync.observeQuota(round, op.quota);
      } else if ("returned" in op) {
        store.db.transaction(() => store.sync.record([], { returns: [op.returned] }))();
        store.sync.notify();
      } else {
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
