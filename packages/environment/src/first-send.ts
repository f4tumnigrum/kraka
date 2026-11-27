import * as v from "valibot";
import {
  canonicalJson,
  CommandReceiptSchema,
  DirectoryRecordSchema,
  ProjectSchema,
  ThreadSchema,
  MessageSchema,
  RoundSchema,
  type AuthorizationTarget,
  type CommandId,
  type CommandReceipt,
  type EnvironmentId,
  type PrincipalId,
  type PermissionItem,
  type SignedRequest,
  type RequestMethodDefinition,
  REQUEST_METHODS,
  type RequestResult,
  type ThreadId,
} from "@kraka/protocol";
import { type FirstSendStore, readReceipt, readProject, readThread } from "./first-send-store";
import { physicalDirectory, projectRoot } from "./project-directory";

export type LocalActor = {
  id: PrincipalId;
  environmentId: EnvironmentId;
  allows: (permission: PermissionItem, target: AuthorizationTarget) => boolean;
};
type Start = Extract<SignedRequest, { method: "thread.start" }>["payload"];
export type FirstSendContext = {
  actor: LocalActor;
  commandId: CommandId;
  transaction: FirstSendStore;
};
function reject(
  commandId: CommandId,
  kind: "idConflict" | "notFound" | "invalidState" | "unsupported",
): CommandReceipt {
  return { kind: "rejected", commandId, failure: { kind } };
}
export function recordCommand(
  context: FirstSendContext,
  operation: RequestMethodDefinition,
  payload: unknown,
  target: AuthorizationTarget,
  apply: () => RequestResult | CommandReceipt,
) {
  const { actor, transaction, commandId } = context;
  const { method, permission } = operation;
  if (actor.environmentId !== transaction.writer.environmentId || !actor.allows(permission, target))
    return {
      kind: "rejected",
      commandId,
      failure: { kind: "missingPermission", permission, target },
    } as const;
  const intent = canonicalJson({ method, target, payload });
  const committed = transaction.db.transaction((): CommandReceipt => {
    const previous = readReceipt(transaction.db, actor.id, commandId);
    if (previous)
      return previous.intent === intent ? previous.receipt : reject(commandId, "idConflict");
    const result = apply();
    const receipt = v.parse(
      CommandReceiptSchema,
      "commandId" in result ? result : { kind: "accepted", commandId, result },
    );
    transaction.db
      .query("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)")
      .run(actor.id, commandId, intent, JSON.stringify(receipt));
    transaction.beforeCommit?.(method);
    return receipt;
  })();
  transaction.sync.notify();
  return committed;
}
export function registerProject(
  context: FirstSendContext & { environmentId: EnvironmentId; realPath: string },
) {
  const { transaction, environmentId, commandId } = context;
  if (environmentId !== transaction.writer.environmentId) return reject(commandId, "notFound");
  const physical = physicalDirectory(context.realPath);
  const realPath = physical?.realPath ?? context.realPath;
  return recordCommand(
    context,
    REQUEST_METHODS.registerProject,
    { realPath },
    { kind: "environment", environmentId },
    () => {
      if (!physical) return reject(commandId, "notFound");
      const old = transaction.db
        .query<{ identity: string; data: string }, [string, string]>(
          "SELECT identity,data FROM projects WHERE environment=? AND path=?",
        )
        .get(environmentId, realPath);
      if (old)
        return old.identity === physical.identity
          ? { kind: "projectRegistered", project: v.parse(ProjectSchema, JSON.parse(old.data)) }
          : reject(commandId, "invalidState");
      const root = projectRoot(realPath);
      const project = v.parse(ProjectSchema, {
        id: crypto.randomUUID(),
        environmentId,
        version: "1",
        root,
      });
      const directory = v.parse(DirectoryRecordSchema, {
        environmentId,
        projectId: project.id,
        realPath,
        binding: {
          kind: "projectRoot",
          directoryId: root.directoryId,
          generation: root.generation,
        },
      });
      transaction.db
        .query("INSERT INTO projects VALUES(?,?,?,?,?,?)")
        .run(
          project.id,
          environmentId,
          realPath,
          physical.identity,
          JSON.stringify(project),
          JSON.stringify(directory),
        );
      return { kind: "projectRegistered", project };
    },
  );
}
export function acceptFirstInput({
  verifiedActor,
  commandId,
  threadStart,
  transaction,
  validate,
  selected,
}: {
  verifiedActor: LocalActor;
  commandId: CommandId;
  threadStart: Start;
  selected?: (roundId: string) => void;
  validate?: () => "notFound" | "invalidState" | "unsupported" | null;
  transaction: FirstSendStore;
}) {
  const { projectId, worktreeId, content } = threadStart;
  return recordCommand(
    { actor: verifiedActor, commandId, transaction },
    REQUEST_METHODS.startThread,
    threadStart,
    { kind: "project", projectId },
    () => {
      const invalid = validate?.();
      if (invalid) return reject(commandId, invalid);
      const project = readProject(transaction.db, projectId);
      if (!project?.root || project.environmentId !== verifiedActor.environmentId)
        return reject(commandId, "notFound");
      if (worktreeId !== null || content.attachments.length || content.references.length)
        return reject(commandId, "unsupported");
      const thread = v.parse(ThreadSchema, {
        id: crypto.randomUUID(),
        projectId,
        worktreeId,
        title: content.text,
        version: "1",
        lineage: { kind: "root" },
        lifecycle: {
          archivedAt: null,
          state: {
            kind: "active",
            pinnedAt: null,
            pinPosition: null,
            manualPosition: null,
            snoozedUntil: null,
          },
        },
        directory: {
          kind: "projectRoot",
          directoryId: project.root.directoryId,
          generation: project.root.generation,
        },
      });
      if (!transaction.directory(thread)) return reject(commandId, "invalidState");
      const roundId = crypto.randomUUID();
      const message = v.parse(MessageSchema, {
        id: crypto.randomUUID(),
        threadId: thread.id,
        roundId,
        ...content,
        version: "1",
        author: { kind: "person", id: verifiedActor.id },
      });
      const round = v.parse(RoundSchema, {
        id: roundId,
        threadId: thread.id,
        messageId: message.id,
        place: "1",
        version: "1",
        attempt: {
          attemptId: crypto.randomUUID(),
          deliveryId: crypto.randomUUID(),
          phase: { kind: "filed", gate: "eligible" },
        },
      });
      transaction.sync.record([
        { objectType: "thread", value: thread },
        { objectType: "message", value: message },
        { objectType: "round", value: round },
      ]);
      selected?.(round.id);
      const { attemptId, deliveryId } = round.attempt;
      transaction.db
        .query("INSERT INTO threads VALUES(?,?)")
        .run(thread.id, JSON.stringify(thread));
      transaction.db
        .query("INSERT INTO messages VALUES(?,?)")
        .run(message.id, JSON.stringify(message));
      transaction.db
        .query("INSERT INTO rounds VALUES(?,?,'person')")
        .run(round.id, JSON.stringify(round));
      transaction.db.query("INSERT INTO deliveries VALUES(?,?,1,NULL)").run(deliveryId, round.id);
      return {
        kind: "threadStarted",
        threadId: thread.id,
        messageId: message.id,
        roundId: round.id,
        attemptId,
        deliveryId,
      };
    },
  );
}
export function renameThread(context: FirstSendContext & { threadId: ThreadId; title: string }) {
  const { threadId, title, transaction, commandId } = context;
  return recordCommand(
    context,
    REQUEST_METHODS.renameThread,
    { threadId, title },
    { kind: "thread", threadId },
    () => {
      const thread = readThread(transaction.db, threadId);
      if (!thread) return reject(commandId, "notFound");
      if (!title || thread.title === title) return reject(commandId, "invalidState");
      const changed = v.parse(ThreadSchema, {
        ...thread,
        title,
        version: String(BigInt(thread.version) + 1n),
      });
      transaction.db
        .query("UPDATE threads SET data=? WHERE id=?")
        .run(JSON.stringify(changed), threadId);
      transaction.sync.record([{ objectType: "thread", value: changed }]);
      return { kind: "threadRenamed", threadId, version: changed.version };
    },
  );
}
