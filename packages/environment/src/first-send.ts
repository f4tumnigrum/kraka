import { changeThreadLifecycle } from "./thread-lifecycle";
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

import { recordCommand, reject, type FirstSendContext, type LocalActor } from "./command-receipts";
import { acceptIsolatedStart } from "./isolated-start";
import { selection } from "./worktree-storage";
type Start = Extract<SignedRequest, { method: "thread.start" }>["payload"];
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
        lineage: verifiedActor.executor
          ? { kind: "child", parentThreadId: verifiedActor.executor.threadId }
          : { kind: "root" },
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
        author: verifiedActor.executor
          ? { kind: "executor", id: verifiedActor.executor.executorInstanceId }
          : { kind: "person", id: verifiedActor.id },
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

export function applyThreadChange(
  context: FirstSendContext,
  payload: Extract<SignedRequest, { method: "thread.changeLifecycle" }>["payload"],
  visibility: string,
) {
  const { transaction: store, commandId, actor } = context;
  const { threadId, baseVersion, change } = payload,
    target = { kind: "thread" as const, threadId };
  return recordCommand(
    context,
    REQUEST_METHODS.changeThreadLifecycle,
    payload,
    target,
    () => {
      const thread = readThread(store.db, threadId);
      if (!thread) return reject(commandId, "notFound");
      if (thread.version !== baseVersion)
        return {
          kind: "rejected",
          commandId,
          failure: { kind: "threadVersionConflict", threadId, currentVersion: thread.version },
        };
      const source = () =>
        store.sync
          .readList(
            { kind: "list", projectId: thread.projectId },
            visibility,
            actor.id,
            (id) => actor.allows("thread.view", { kind: "thread", threadId: id }),
            () => false,
          )
          .sources.get(threadId);
      const old = source();
      if (!old) return reject(commandId, "notFound");
      const blocked =
        old.facts.requests.some(
          (r) => r.request.state.kind === "open" && r.request.body.kind === "approval",
        ) ||
        old.facts.rounds.some(
          (r) =>
            !r.quota &&
            !["finished", "endedEarly", "notDelivered"].includes(r.round.attempt.phase.kind),
        );
      const lifecycle = changeThreadLifecycle(old.summary.lifecycle, change, Date.now(), blocked);
      if (!lifecycle) return reject(commandId, "invalidState");
      const updated = v.parse(ThreadSchema, {
        ...thread,
        lifecycle,
        version: String(BigInt(thread.version) + 1n),
      });
      store.db.query("UPDATE threads SET data=? WHERE id=?").run(JSON.stringify(updated), threadId);
      store.sync.record([{ objectType: "thread", value: updated }]);
      const result = source();
      if (!result) throw Error("Committed lifecycle is missing its summary");
      return { kind: "threadChanged", summary: result.summary };
    },
    ["thread.view"],
  );
}
