import type { CommandId } from "@kraka/protocol";
import type { FirstSendStore } from "./first-send-store";
import type { RollbackOperation, RollbackOperationStore } from "./rollback-store";
import { exclusiveCheckout } from "./rollback-target";
import { parseRestorePlan, restoreWorkspace, RestoreFailure } from "./rollback-files";
import type { DirectoryLease } from "./directory-lease";

async function execute(operations: RollbackOperationStore, op: RollbackOperation) {
  const {
      progress: { target, commandId },
      binding,
    } = op,
    { store, runtime } = operations;
  if (!runtime) return;
  const identity = operations.identity(op);
  if (!identity) return;
  async function run(lease?: DirectoryLease) {
    const current = operations.read(commandId);
    if (!current || !operations.identity(current)) return;
    const { files, dialogue } = current.progress;
    const needsFiles = files.kind === "pending" || files.kind === "running";
    if (
      files.kind === "failed" ||
      files.kind === "unknown" ||
      dialogue.kind === "unknown" ||
      dialogue.kind === "failed"
    )
      return;
    const exclusive = () => !!operations.identity(op) && exclusiveCheckout(store, identity!.thread);
    let workspace: ReturnType<typeof restoreWorkspace> | undefined;
    let plan: ReturnType<typeof parseRestorePlan> | undefined;
    if (needsFiles && "captureId" in target && lease && identity?.capture) {
      try {
        if (!runtime!.allowed(op, "workspace.change"))
          throw new RestoreFailure("failed", "permissionRevoked");
        if (!exclusive()) throw new RestoreFailure("failed", "sharedWorkspace");
        workspace = restoreWorkspace(store, lease, target, identity.capture);
        workspace.preflight();
        const saved = store.db
          .query<{ plan: string | null }, [string]>(
            "SELECT plan FROM rollback_operations WHERE id=?",
          )
          .get(commandId);
        if (saved?.plan) {
          plan = parseRestorePlan(saved.plan);
          workspace.validate(plan);
        } else {
          if (files.kind === "running")
            throw new RestoreFailure("unknown", "restorePlanUnavailable");
          plan = workspace.snapshot();
          store.db.run("UPDATE rollback_operations SET plan=? WHERE id=? AND plan IS NULL", [
            JSON.stringify(plan),
            commandId,
          ]);
        }
      } catch (error) {
        const reason = error instanceof Error ? error.message : "checkpointUnavailable";
        operations.report(
          op,
          files.kind === "pending"
            ? {
                kind: "preflightFailed",
                part: "files",
                commandId,
                execution: files.execution,
                reason,
                retryable: ["indexLocked", "sharedWorkspace"].includes(reason),
              }
            : { kind: "unknown", part: "files", commandId, execution: files.execution, reason },
        );
        return;
      }
    }
    if (dialogue.kind === "pending" || dialogue.kind === "running") {
      if (
        dialogue.kind === "pending" &&
        !operations.report(op, {
          kind: "claim",
          commandId,
          part: "dialogue",
          execution: dialogue.execution,
        })
      )
        return;
      const result = runtime!.allowed(op, "thread.send")
        ? await runtime!.rewind(op, dialogue.kind === "running").catch(() => "unknown" as const)
        : dialogue.kind === "running"
          ? "unknown"
          : "failed";
      const ticket = { commandId, part: "dialogue", execution: dialogue.execution } as const;
      const next = operations.report(
        op,
        result === "succeeded"
          ? { ...ticket, kind: result }
          : result === "unknown"
            ? { ...ticket, kind: result, reason: "nativeResultUnknown" }
            : { ...ticket, kind: result, reason: "rewindRejected", retryable: true },
      );
      if (!next || result !== "succeeded") return;
      await operations.dialogueCommitted?.(commandId, dialogue.execution);
    }
    if (!needsFiles || !workspace || !identity?.capture) return;
    const ticket = { commandId, part: "files", execution: files.execution } as const;
    if (!runtime!.allowed(op, "workspace.change") || !exclusive()) {
      operations.report(
        op,
        files.kind === "running"
          ? { ...ticket, kind: "unknown", reason: "sharedWorkspace" }
          : { ...ticket, kind: "preflightFailed", reason: "sharedWorkspace", retryable: true },
      );
      return;
    }
    try {
      if (!plan) throw new RestoreFailure("unknown", "restorePlanUnavailable");
      if (
        files.kind === "pending" &&
        !operations.report(op, {
          ...ticket,
          kind: "claim",
          capture: identity.capture,
          exclusive: true,
        })
      )
        return;
      await workspace.apply(
        plan,
        () => exclusive() && runtime!.allowed(op, "workspace.change"),
        (p) => operations.pathWrite?.(commandId, p),
      );
      operations.report(op, { ...ticket, kind: "succeeded" });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "fileIO",
        state = operations.read(commandId)?.progress.files;
      if (state?.kind === "pending")
        operations.report(op, { ...ticket, kind: "preflightFailed", reason, retryable: true });
      else if (
        files.kind === "running" ||
        (error instanceof RestoreFailure && error.disposition === "unknown")
      )
        operations.report(op, { ...ticket, kind: "unknown", reason });
      else operations.report(op, { ...ticket, kind: "failed", reason, retryable: true });
    }
  }
  if (binding && (op.progress.files.kind === "running" || op.progress.files.kind === "pending")) {
    try {
      await store.captures.writers.withDirectoryLease(
        {
          environmentId: store.writer.environmentId,
          directoryId: binding.directoryId,
          generation: binding.generation,
          operationId: commandId,
        },
        run,
      );
    } catch (error) {
      const files = operations.read(commandId)?.progress.files;
      if (files?.kind === "pending" || files?.kind === "running") {
        const reason = error instanceof Error ? error.message : "directoryUnavailable",
          ticket = { commandId, execution: files.execution, part: "files" } as const;
        operations.report(
          op,
          files.kind === "pending"
            ? { ...ticket, kind: "preflightFailed", reason, retryable: true }
            : { ...ticket, kind: "unknown", reason },
        );
      }
    }
  } else await run();
}
export function reconcileRollback({
  operationId,
  writer,
}: {
  operationId: CommandId;
  writer: FirstSendStore;
}): Promise<void> {
  const operations = writer.services.rollbacks,
    prior = operations.active.get(operationId);
  if (prior)
    return prior.then(() => {
      if (operations.unfinished().includes(operationId))
        return reconcileRollback({ operationId, writer });
    });
  const op = operations.read(operationId);
  if (!op) return Promise.resolve();
  const task = Promise.resolve()
    .then(() => execute(operations, op))
    .finally(() => operations.active.delete(operationId));
  operations.active.set(operationId, task);
  return task;
}
