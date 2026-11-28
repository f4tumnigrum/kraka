import * as v from "valibot";
import {
  AttemptIdSchema,
  canonicalJson,
  DeliveryIdSchema,
  HandoffEntrySchema,
  HandoffContextSchema,
  InputContentSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  SessionBindingSchema,
  type ContextTransferId,
  type HandoffContext,
  type SessionTransitionPreview,
} from "@kraka/protocol";
import { loadPreview } from "./session-preview";
import type { FirstSendStore } from "./first-send-store";
import type { ThreadSessionBinding, FrozenDelivery, DeliveryStore } from "./executor-records";
import { readMessage } from "./first-send-store";

const frozenSchema = v.strictObject({
  attemptId: AttemptIdSchema,
  deliveryId: DeliveryIdSchema,
  target: SessionBindingSchema,
  messageVersion: ObjectVersionSchema,
  input: v.strictObject({ id: MessageIdSchema, ...InputContentSchema.entries }),
  parts: v.strictTuple([]),
  handoff: HandoffContextSchema,
  handoffEntries: v.array(HandoffEntrySchema),
});
export type FrozenTextHandoff = v.InferOutput<typeof frozenSchema>;
export class HandoffDeliveries implements DeliveryStore {
  constructor(readonly store: FirstSendStore) {}
  get(id: FrozenDelivery["deliveryId"]) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM session_frozen WHERE id=?")
      .get(id);
    return row ? v.parse(frozenSchema, JSON.parse(row.data)) : null;
  }
  async read(id: FrozenDelivery["deliveryId"]) {
    return this.get(id);
  }
  async record(record: FrozenDelivery) {
    const delivery = v.parse(frozenSchema, record);
    const data = canonicalJson(delivery);
    if (
      this.store.db.run("INSERT OR IGNORE INTO session_frozen VALUES(?,?)", [
        delivery.deliveryId,
        data,
      ]).changes
    )
      return "stored" as const;
    return canonicalJson(this.get(delivery.deliveryId)) === data
      ? ("unchanged" as const)
      : ("conflict" as const);
  }
}
export async function freezeTextHandoff(
  store: FirstSendStore,
  args: {
    previewId: SessionTransitionPreview["id"];
    source: HandoffContext["source"];
    expectedBinding: ThreadSessionBinding | null;
    targetBinding: ThreadSessionBinding;
    attemptId: FrozenDelivery["attemptId"];
    deliveryId: FrozenDelivery["deliveryId"];
    transferId: ContextTransferId;
    input: FrozenDelivery["input"];
    messageVersion: FrozenDelivery["messageVersion"];
  },
) {
  const {
    source,
    expectedBinding,
    targetBinding,
    attemptId,
    deliveryId,
    transferId,
    input,
    messageVersion,
  } = args;
  const deliveries = new HandoffDeliveries(store);
  const saved = loadPreview(store, args.previewId);
  const preview = saved?.preview;
  const conflict = { kind: "conflict" } as const;
  if (
    !saved ||
    preview?.kind !== "createWithHandoff" ||
    !Bun.deepEquals(source, preview.source) ||
    !Bun.deepEquals(expectedBinding, preview.expectedBinding) ||
    targetBinding.threadId !== preview.threadId ||
    !targetBinding.nativeSessionId ||
    targetBinding.instanceId !== preview.target.instanceId ||
    targetBinding.family !== preview.target.family ||
    targetBinding.epoch !== (expectedBinding?.epoch ?? 0) + 1 ||
    attemptId !== targetBinding.attemptId
  )
    return conflict;
  const { id: messageId, ...content } = input;
  if (!Bun.deepEquals(content, saved.payload.proposedInput)) return conflict;
  const delivery: FrozenTextHandoff = {
    target: targetBinding,
    attemptId,
    deliveryId,
    messageVersion,
    input: { ...content, id: messageId },
    parts: [],
    handoff: {
      transferId,
      source,
      messageIds: preview.entries.map((e) => e.id),
      history: preview.history,
    },
    handoffEntries: preview.entries,
  };
  const old = await deliveries.read(deliveryId);
  if (old)
    return Bun.deepEquals(old, delivery) ? { kind: "unchanged" as const, delivery: old } : conflict;
  for (const entry of preview.entries) {
    const message = readMessage(store.db, entry.id);
    if (
      !message ||
      message.version !== entry.version ||
      message.text !== entry.text ||
      (message.author.kind === "person" ? "user" : "assistant") !== entry.role
    )
      return conflict;
  }
  const kind = await deliveries.record(delivery);
  return kind === "conflict" ? conflict : { kind, delivery };
}
