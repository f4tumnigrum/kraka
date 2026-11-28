import type { CommandReceipt } from "@kraka/protocol";
import type { InputOutbox, InputScope } from "./outbox";
export function editRolledBackPrompt(
  outbox: InputOutbox,
  scope: InputScope,
  receipt: CommandReceipt,
) {
  if (receipt.kind !== "accepted" || receipt.result.kind !== "checkpointRollback") return null;
  const { progress, draft } = receipt.result;
  if (
    !draft ||
    progress.dialogue.kind !== "succeeded" ||
    progress.target.threadId !== scope.threadId
  )
    return null;
  return outbox.saveDraft(scope, draft.text, draft);
}
export function fileRestoreMessage(progress: import("@kraka/protocol").RollbackProgress) {
  return progress.files.kind === "failed" && progress.files.reason === "sharedWorkspace"
    ? "File restore requires an isolated checkout. Release the other writer, then retry files."
    : null;
}
export function rollbackEffectsLabel(progress: import("@kraka/protocol").RollbackProgress) {
  return progress.externalEffects === undefined
    ? "external effects not recorded"
    : String(progress.externalEffects.length) + " confirmed external effects";
}
