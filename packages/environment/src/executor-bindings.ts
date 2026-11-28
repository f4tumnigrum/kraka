import * as v from "valibot";
import {
  canonicalJson,
  AdapterFamilySchema,
  DeliveryIdSchema,
  NativeSessionIdSchema,
  AttemptIdSchema,
  ExecutorInstanceIdSchema,
  ThreadIdSchema,
  type ThreadId,
  type Round,
} from "@kraka/protocol";
import type { FirstSendStore } from "./first-send-store";
import { frozenInput } from "./input-store";
const schema = v.object({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  nativeSessionId: NativeSessionIdSchema,
  attemptId: AttemptIdSchema,
  threadId: ThreadIdSchema,
  epoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  context: v.string(),
});
export type ExecutorBinding = v.InferOutput<typeof schema>;
export function savedBinding(store: FirstSendStore, thread: ThreadId) {
  const row = store.db
    .query<{ data: string }, [string]>(
      "SELECT data FROM codex_bindings WHERE thread=? ORDER BY epoch DESC LIMIT 1",
    )
    .get(thread);
  return row ? v.parse(schema, JSON.parse(row.data)) : null;
}
export function replaceBinding(
  store: FirstSendStore,
  expected: ExecutorBinding | null,
  next: ExecutorBinding,
  legacyEpoch = 0,
) {
  if (
    next.epoch !== (expected?.epoch ?? legacyEpoch) + 1 ||
    !Bun.deepEquals(savedBinding(store, next.threadId), expected)
  )
    return false;
  return (
    store.db.run("INSERT INTO codex_bindings VALUES(?,?,?)", [
      next.threadId,
      next.epoch,
      canonicalJson(next),
    ]).changes === 1
  );
}
// A frozen pre-S13 delivery still identifies the conversation created by the last native process.
export function latestFrozenSession(store: FirstSendStore, round: Round) {
  const row = store.db
    .query<{ delivery: string }, [string]>(
      "SELECT d.id delivery FROM deliveries d JOIN rounds r ON d.round=r.id WHERE json_extract(r.data,'$.threadId')=? AND d.frozen IS NOT NULL ORDER BY r.rowid DESC,d.rowid DESC LIMIT 1",
    )
    .get(round.threadId);
  return row ? frozenInput(store, v.parse(DeliveryIdSchema, row.delivery))?.target : null;
}
