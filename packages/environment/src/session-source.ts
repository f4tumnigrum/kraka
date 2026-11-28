import * as v from "valibot";
import {
  AdapterFamilySchema,
  ChildModelSchema,
  ExecutorInstanceIdSchema,
  NativeSessionIdSchema,
  MessageSchema,
  type Round,
  type ThreadId,
  type NativeItemId,
  type ExecutorInstanceId,
} from "@kraka/protocol";
import { type FirstSendStore, readMessage } from "./first-send-store";
const verifiedSource = v.strictObject({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  account: v.string(),
  continuationKey: v.string(),
  checkout: v.string(),
  nativeSessionId: NativeSessionIdSchema,
  model: ChildModelSchema,
});
export function saveImportedSessionSource(
  store: FirstSendStore,
  threadId: ThreadId,
  source: v.InferOutput<typeof verifiedSource>,
) {
  const data = v.parse(verifiedSource, source);
  store.db.run("INSERT OR IGNORE INTO imported_session_sources VALUES(?,?)", [
    threadId,
    JSON.stringify(data),
  ]);
  return Bun.deepEquals(readImportedSessionSource(store, threadId), data);
}
export function readImportedSessionSource(store: FirstSendStore, threadId: ThreadId) {
  const row = store.db
    .query<{ data: string }, [string]>("SELECT data FROM imported_session_sources WHERE thread=?")
    .get(threadId);
  return row ? v.parse(verifiedSource, JSON.parse(row.data)) : null;
}
export function recordAssistantMessage(
  store: FirstSendStore,
  round: Round,
  instance: ExecutorInstanceId,
  item: NativeItemId,
  text: string,
) {
  store.db.transaction(() => {
    const id = JSON.stringify([round.attempt.attemptId, instance, item]),
      old = readMessage(store.db, id);
    if (old?.text === text) return;
    const message = v.parse(MessageSchema, {
      id,
      threadId: round.threadId,
      roundId: round.id,
      version: String(BigInt(old?.version ?? 0) + 1n),
      author: { kind: "executor", id: instance },
      references: [],
      attachments: [],
      text,
    });
    store.db.run(
      "INSERT INTO messages VALUES(?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data",
      [id, JSON.stringify(message)],
    );
    store.sync.record([{ objectType: "message", value: message }]);
  })();
  store.sync.notify();
}
