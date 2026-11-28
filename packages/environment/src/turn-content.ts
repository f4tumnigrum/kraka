import * as v from "valibot";
import {
  MessageSchema,
  type Message,
  type Round,
  type ExecutorInstanceId,
  type NativeItemId,
} from "@kraka/protocol";
import type { FirstSendStore } from "./first-send-store";
export function turnContent(store: FirstSendStore, round: Round, instanceId: ExecutorInstanceId) {
  const items = new Map<NativeItemId, Message>();
  const append = (item: NativeItemId, text: string, final: string | null) => {
    const previous = items.get(item);
    const message = v.parse(MessageSchema, {
      id: previous?.id ?? crypto.randomUUID(),
      threadId: round.threadId,
      roundId: round.id,
      author: { kind: "executor", id: instanceId },
      text: final ?? (previous?.text ?? "") + text,
      references: [],
      attachments: [],
      version: String(BigInt(previous?.version ?? 0) + 1n),
    });
    store.db.transaction(() => {
      store.db.run("INSERT OR REPLACE INTO messages VALUES(?,?)", [
        message.id,
        JSON.stringify(message),
      ]);
      store.sync.record([{ objectType: "message", value: message }]);
    })();
    items.set(item, message);
    store.sync.notify();
  };
  return Object.assign(append, {
    text: () => Array.from(items.values(), (message) => message.text).join("\n"),
  });
}
