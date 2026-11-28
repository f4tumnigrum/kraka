import { reconcileRollback, readThread } from "@kraka/environment";
import type { CommandReceipt } from "@kraka/protocol";
import type { Handler } from "./context";
type Methods =
  | "checkpoint.previewRollback"
  | "checkpoint.readRollbackPart"
  | "checkpoint.restoreFiles"
  | "checkpoint.retryDialogue"
  | "checkpoint.retryFiles"
  | "checkpoint.rollback"
  | "checkpoint.rollbackDialogue";
export const rollback: Handler<Methods> = (req, c) => {
  const actor = { ...c.principal, device: c.deviceId };
  const ledger = c.store.services.rollbacks;
  const payload = req.payload,
    { commandId } = req;
  const threadId = "target" in payload ? payload.target.threadId : payload.threadId;
  const allowed = () => c.allows(threadId, "thread.view");
  if (!readThread(c.store.db, threadId) || !allowed())
    return { kind: "rejected", commandId, failure: { kind: "notFound" } };
  const required =
    req.method === "checkpoint.retryDialogue"
      ? "thread.send"
      : req.method === "checkpoint.retryFiles"
        ? "workspace.change"
        : null;
  if (required && !c.allows(threadId, required))
    return {
      kind: "rejected",
      commandId,
      failure: {
        kind: "missingPermission",
        target: { kind: "thread", threadId },
        permission: required,
      },
    };
  const original = "operationId" in payload ? ledger.read(payload.operationId) : null;
  const target =
    "target" in payload
      ? payload.target
      : "boundary" in payload
        ? payload
        : original?.progress.target;
  if (
    target &&
    target.threadId === threadId &&
    "directoryId" in target &&
    !c.session.features.includes("directoryDiff")
  )
    return { kind: "rejected", commandId, failure: { kind: "unsupported" } };
  let result: CommandReceipt;
  switch (req.method) {
    case "checkpoint.previewRollback":
      result = {
        kind: "accepted",
        commandId,
        result: ledger.preview(actor, req.payload.target, req.payload.mode),
      };
      break;
    case "checkpoint.readRollbackPart":
      result = ledger.readRollbackPart({ actor, commandId, ...req.payload });
      break;
    case "checkpoint.retryFiles":
    case "checkpoint.retryDialogue":
      result = ledger.retry(actor, req);
      break;
    default:
      result = ledger.startRollback({ actor, request: req });
  }
  if (result.kind !== "accepted") return result;
  const scope = c.visibility();
  c.disclose(result, () => c.active() && allowed() && c.visibility() === scope);
  c.wake();
  if (result.result.kind === "checkpointRollback" && req.method !== "checkpoint.readRollbackPart")
    void reconcileRollback({ operationId: result.result.progress.commandId, writer: c.store });
};
