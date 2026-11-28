import * as v from "valibot";
import {
  canonicalJson,
  CommandReceiptSchema,
  type AuthorizationTarget,
  type CommandId,
  type CommandReceipt,
  type EnvironmentId,
  type ExecutorPrincipal,
  type PrincipalId,
  type PermissionItem,
  type RequestMethodDefinition,
  type RequestResult,
} from "@kraka/protocol";
import { type FirstSendStore, readReceipt } from "./first-send-store";
export type LocalActor = {
  id: PrincipalId;
  executor?: ExecutorPrincipal;
  environmentId: EnvironmentId;
  allows: (permission: PermissionItem, target: AuthorizationTarget) => boolean;
};
export type FirstSendContext = {
  actor: LocalActor;
  commandId: CommandId;
  transaction: FirstSendStore;
};
export function reject(
  commandId: CommandId,
  kind: "idConflict" | "notFound" | "invalidState" | "unsupported",
): CommandReceipt {
  return { kind: "rejected", commandId, failure: { kind } };
}
export function commandIntent(
  actor: LocalActor,
  method: string,
  target: AuthorizationTarget,
  payload: unknown,
) {
  return canonicalJson({
    method,
    target,
    payload,
    ...(actor.executor && { attemptId: actor.executor.attemptId }),
  });
}
export function checkCommand(
  context: FirstSendContext,
  operation: RequestMethodDefinition,
  payload: unknown,
  target: AuthorizationTarget,
  additional: PermissionItem[] = [],
) {
  const { actor, transaction, commandId } = context;
  const missing = [operation.permission, ...additional].find(
    (right) =>
      actor.environmentId !== transaction.writer.environmentId || !actor.allows(right, target),
  );
  const intent = commandIntent(actor, operation.method, target, payload);
  if (missing)
    return {
      intent,
      receipt: {
        kind: "rejected",
        commandId,
        failure: { kind: "missingPermission", permission: missing, target },
      } satisfies CommandReceipt,
    };
  const previous = readReceipt(transaction.db, actor.id, commandId);
  if (previous)
    return {
      intent,
      receipt: previous.intent === intent ? previous.receipt : reject(commandId, "idConflict"),
    };
  const pending = transaction.db
    .query<{ intent: string }, [string, string]>(
      "SELECT intent FROM restoring_commands WHERE actor=? AND command=?",
    )
    .get(actor.id, commandId);
  return {
    intent,
    receipt: pending && pending.intent !== intent ? reject(commandId, "idConflict") : null,
  };
}
export function recordCommand(
  context: FirstSendContext,
  operation: RequestMethodDefinition,
  payload: unknown,
  target: AuthorizationTarget,
  apply: () => RequestResult | CommandReceipt,
  additional: PermissionItem[] = [],
) {
  const { actor, transaction, commandId } = context;
  const committed = transaction.db.transaction((): CommandReceipt => {
    const { receipt: prior, intent } = checkCommand(
      context,
      operation,
      payload,
      target,
      additional,
    );
    if (prior) return prior;
    const result = apply();
    const receipt = v.parse(
      CommandReceiptSchema,
      "commandId" in result ? result : { kind: "accepted", commandId, result },
    );
    transaction.db
      .query("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)")
      .run(actor.id, commandId, intent, JSON.stringify(receipt));
    transaction.beforeCommit?.(operation.method);
    return receipt;
  })();
  transaction.sync.notify();
  return committed;
}
