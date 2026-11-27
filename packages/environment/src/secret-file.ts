import type {
  CommandId,
  DeliveryId,
  SecretReceipt,
  SecretFileGrant,
  SecretTarget,
} from "@kraka/protocol";

/** Resolve the current target from the live request. A public receipt alone cannot authorize file delivery. */
export function secretFileGrant(
  receipt: SecretReceipt,
  target: SecretTarget,
  winner: {
    receiptCommandId: CommandId;
    decisionCommandId: CommandId;
    ownerId: SecretReceipt["ownerId"];
  },
  deliveryId: DeliveryId,
  now: number,
): SecretFileGrant | null {
  const saved = receipt.target;
  if (
    receipt.decision !== "stored" ||
    receipt.ownerId !== winner.ownerId ||
    receipt.receiptCommandId !== winner.receiptCommandId ||
    now < receipt.savedAt ||
    now >= receipt.expiresAt ||
    now - receipt.savedAt >= 86_400_000 ||
    saved.purpose.kind !== "commandFile" ||
    target.purpose.kind !== "commandFile" ||
    saved.purpose.commandId !== target.purpose.commandId ||
    saved.purpose.tool !== target.purpose.tool ||
    saved.environmentId !== target.environmentId ||
    saved.projectId !== target.projectId ||
    saved.threadId !== target.threadId ||
    saved.todoRequestId !== target.todoRequestId ||
    saved.version !== target.version ||
    saved.attemptId !== target.attemptId ||
    saved.sessionId !== target.sessionId ||
    saved.instanceId !== target.instanceId ||
    saved.requestId !== target.requestId
  )
    return null;
  return {
    ...winner,
    deliveryId,
    target: { ...target, purpose: target.purpose },
    expiresAt: Math.min(receipt.expiresAt, receipt.savedAt + 86_400_000),
  };
}
