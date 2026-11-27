import * as v from "valibot";
import {
  AttemptIdSchema,
  ContextTransferIdSchema,
  DeliveryIdSchema,
  EnvironmentIdSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  RoundIdSchema,
  ThreadIdSchema,
} from "./ids";

const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const sourceThread = { environmentId: EnvironmentIdSchema, threadId: ThreadIdSchema };
export const HandoffSourceSchema = v.strictObject({ ...sourceThread, roundId: RoundIdSchema });
export const MissingHistorySourceSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("missingThread"), ...sourceThread }),
  v.strictObject({ kind: v.literal("missingRound"), ...HandoffSourceSchema.entries }),
  v.strictObject({ kind: v.literal("cycle"), ...HandoffSourceSchema.entries }),
]);
/** Coverage describes ancestor traversal. Budget omissions are counted even when traversal is complete. */
export const HistoryCoverageSchema = v.variant("coverage", [
  v.strictObject({
    coverage: v.literal("complete"),
    missingSources: v.strictTuple([]),
    omittedItems: count,
  }),
  v.strictObject({
    coverage: v.literal("partial"),
    missingSources: v.tupleWithRest([MissingHistorySourceSchema], MissingHistorySourceSchema),
    omittedItems: count,
  }),
  v.strictObject({ coverage: v.literal("unknown"), omittedItems: v.nullable(count) }),
]);
export const HandoffContextSchema = v.strictObject({
  transferId: ContextTransferIdSchema,
  source: HandoffSourceSchema,
  messageIds: v.array(MessageIdSchema),
  history: HistoryCoverageSchema,
});
/** Confirms that text was stored for the target's next input. Delivery progress belongs to the identified attempt. */
export const TextReturnResultSchema = v.strictObject({
  kind: v.literal("textReturned"),
  transferId: ContextTransferIdSchema,
  source: HandoffSourceSchema,
  target: v.strictObject(sourceThread),
  text: v.string(),
  history: HistoryCoverageSchema,
  input: v.strictObject({
    messageId: MessageIdSchema,
    roundId: RoundIdSchema,
    attemptId: AttemptIdSchema,
    deliveryId: DeliveryIdSchema,
  }),
});
export const TextReturnedEventSchema = v.strictObject({
  kind: v.literal("handoff.textReturned"),
  result: TextReturnResultSchema,
  version: ObjectVersionSchema,
});
export type HistoryCoverage = v.InferOutput<typeof HistoryCoverageSchema>;
export type HandoffContext = v.InferOutput<typeof HandoffContextSchema>;
export type TextReturnResult = v.InferOutput<typeof TextReturnResultSchema>;
export type TextReturnedEvent = v.InferOutput<typeof TextReturnedEventSchema>;
export const handoffSchemas = {
  ContextTransferId: ContextTransferIdSchema,
  HandoffSource: HandoffSourceSchema,
  MissingHistorySource: MissingHistorySourceSchema,
  HistoryCoverage: HistoryCoverageSchema,
  HandoffContext: HandoffContextSchema,
  TextReturnResult: TextReturnResultSchema,
  TextReturnedEvent: TextReturnedEventSchema,
};
