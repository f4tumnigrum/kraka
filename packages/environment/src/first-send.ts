import * as v from "valibot";
import {
  DirectoryRecordSchema,
  ProjectSchema,
  ThreadSchema,
  ThreadIdSchema,
  RoundIdSchema,
  MessageSchema,
  RoundSchema,
  type CommandId,
  type EnvironmentId,
  type SignedRequest,
  REQUEST_METHODS,
  type ThreadId,
} from "@kraka/protocol";
import { type FirstSendStore, readProject, readThread } from "./first-send-store";
import { physicalDirectory, projectRoot } from "./project-directory";

import { record, reject, type CommandContext, type LocalActor } from "./command-receipts";
import { acceptIsolatedStart } from "./isolated-start";
import { selection } from "./worktree-storage";
type Start = Extract<SignedRequest, { method: "thread.start" }>["payload"];
export function registerProject(
  context: CommandContext & { environmentId: EnvironmentId; realPath: string },
) {
  const { transaction, environmentId, commandId } = context;
  if (environmentId !== transaction.writer.environmentId) return reject(commandId, "notFound");
  const physical = physicalDirectory(context.realPath);
  const realPath = physical?.realPath ?? context.realPath;
  return record(
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
}: {
  verifiedActor: LocalActor;
  commandId: CommandId;
  threadStart: Start;
  transaction: FirstSendStore;
}) {
  const { projectId, worktreeId, content } = threadStart;
  return record(
    { actor: verifiedActor, commandId, transaction },
    REQUEST_METHODS.startThread,
    threadStart,
    { kind: "project", projectId },
    () => {
      const project = readProject(transaction.db, projectId);
      if (!project?.root || project.environmentId !== verifiedActor.environmentId)
        return reject(commandId, "notFound");
      if (content.attachments.length || content.references.length)
        return reject(commandId, "unsupported");
      const threadId = v.parse(ThreadIdSchema, crypto.randomUUID()),
        roundId = v.parse(RoundIdSchema, crypto.randomUUID());
      const directory =
        worktreeId !== null
          ? acceptIsolatedStart({
              actor: verifiedActor,
              commandId,
              transaction,
              project,
              threadId,
              roundId,
              worktreeId,
              selectedOrigin: selection(transaction.db, verifiedActor.id, projectId, worktreeId),
            })
          : {
              kind: "projectRoot",
              directoryId: project.root.directoryId,
              generation: project.root.generation,
            };
      if (!directory) return reject(commandId, "invalidState");
      const thread = v.parse(ThreadSchema, {
        id: threadId,
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
        directory,
      });
      if (worktreeId === null && !transaction.directory(thread))
        return reject(commandId, "invalidState");

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
          phase: { kind: "filed", gate: worktreeId === null ? "eligible" : "held" },
        },
      });
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
      transaction.db
        .query("INSERT INTO deliveries VALUES(?,?,?,NULL)")
        .run(deliveryId, round.id, Number(worktreeId === null));
      return {
        kind: "threadStarted",
        threadId: thread.id,
        messageId: message.id,
        roundId: round.id,
        attemptId,
        deliveryId,
      };
    },
    worktreeId === null ? [] : ["workspace.change"],
  );
}
export function renameThread(context: CommandContext & { threadId: ThreadId; title: string }) {
  const { threadId, title, transaction, commandId } = context;
  return record(
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
      return { kind: "threadRenamed", threadId, version: changed.version };
    },
  );
}
