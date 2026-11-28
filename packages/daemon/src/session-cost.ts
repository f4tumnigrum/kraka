import * as v from "valibot";
import { NativeSessionIdSchema, type Round, type DeliveryId } from "@kraka/protocol";
import type { ExecutorSession, FirstSendStore } from "@kraka/environment";
import type { ExecutorSelection } from "./executor-instances";

const feeResult = v.object({
  scope: v.literal("session"),
  nativeSessionId: NativeSessionIdSchema,
  amounts: v.array(
    v.object({
      amount: v.pipe(v.number(), v.minValue(0), v.maxValue(Number.MAX_VALUE)),
      currency: v.pipe(v.string(), v.minLength(1)),
      priceSource: v.picklist(["reported", "providerEstimated"]),
    }),
  ),
});
export async function recordSessionCost(
  store: FirstSendStore,
  session: ExecutorSession,
  selection: ExecutorSelection,
  round: Round,
  deliveryId: DeliveryId,
  current: () => boolean,
  now: () => number,
) {
  const support = selection.snapshot.matrix.reportCost;
  if (support.kind === "unsupported" || !current() || !session.nativeSessionId) return;
  const reply = await session.invoke(
    { support, capabilityVersion: selection.snapshot.version },
    {
      kind: "service",
      capability: "reportCost",
      request: { kind: "cost", scope: "session" },
      deliveryId,
    },
  );
  if (reply.kind !== "ok" || reply.value.kind !== "service" || !current()) return;
  const result = v.safeParse(feeResult, reply.value.result);
  if (!result.success || result.output.nativeSessionId !== session.nativeSessionId) return;
  for (const fee of result.output.amounts) {
    store.services.accountUsage.recordUsage({
      instanceId: session.instanceId,
      threadId: round.threadId,
      nativeSessionId: session.nativeSessionId,
      scope: { kind: "session" },
      sourceId: JSON.stringify(["sessionCost", fee.currency, fee.priceSource]),
      model: selection.model.id,
      observedAt: now(),
      counters: {
        uncachedInput: null,
        cacheRead: null,
        cacheWrite: null,
        output: null,
        reasoning: null,
        total: null,
      },
      ...fee,
    });
  }
}
