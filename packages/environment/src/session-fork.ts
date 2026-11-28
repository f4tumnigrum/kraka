import * as v from "valibot";
import {
  ForkTransferSchema,
  REQUEST_METHODS,
  RoundIdSchema,
  ThreadSchema,
  type ForkTransfer,
  type SignedRequest,
  type ThreadId,
  type WorkRelationship,
} from "@kraka/protocol";
import { type FirstSendContext, recordCommand, reject } from "./command-receipts";
import { type FirstSendStore, readProject, readRound, readThread } from "./first-send-store";

export function pendingFork(store: FirstSendStore, threadId: ThreadId) {
  const row = store.db
    .query<{ data: string }, [string]>("SELECT data FROM session_forks WHERE child=?")
    .get(threadId);
  return row ? v.parse(ForkTransferSchema, JSON.parse(row.data)) : null;
}
export function reservedForkRound(store: FirstSendStore, threadId: ThreadId) {
  const saved = pendingFork(store, threadId);
  return saved && !readRound(store.db, saved.firstRoundId) ? saved.firstRoundId : null;
}
export function forkAtRound(
  ctx: FirstSendContext,
  payload: Extract<SignedRequest, { method: "thread.fork" }>["payload"],
) {
  const { transaction: store, actor, commandId } = ctx;
  const { sourceThreadId, sourceRoundId } = payload;
  return recordCommand(
    ctx,
    REQUEST_METHODS.forkThread,
    payload,
    { kind: "thread", threadId: sourceThreadId },
    () => {
      const parent = readThread(store.db, sourceThreadId),
        round = readRound(store.db, sourceRoundId);
      if (!parent || round?.threadId !== sourceThreadId) return reject(commandId, "notFound");
      if (round.attempt.phase.kind !== "finished" && round.attempt.phase.kind !== "endedEarly")
        return reject(commandId, "invalidState");
      const project = readProject(store.db, parent.projectId);
      if (
        !project?.root ||
        project.environmentId !== actor.environmentId ||
        !store.projectDirectory(project.id)
      )
        return reject(commandId, "invalidState");
      const child = v.parse(ThreadSchema, {
        id: crypto.randomUUID(),
        projectId: parent.projectId,
        worktreeId: null,
        title: parent.title,
        version: "1",
        directory: {
          kind: "projectRoot",
          directoryId: project.root.directoryId,
          generation: project.root.generation,
        },
        lineage: { kind: "fork", sideChat: false, parentThreadId: sourceThreadId, sourceRoundId },
      });
      if (!store.directory(child)) return reject(commandId, "invalidState");
      const fork = v.parse(ForkTransferSchema, {
        source: {
          environmentId: actor.environmentId,
          threadId: sourceThreadId,
          roundId: sourceRoundId,
        },
        targetThreadId: child.id,
        transferId: crypto.randomUUID(),
        firstRoundId: v.parse(RoundIdSchema, crypto.randomUUID()),
        state: "pending",
      });
      store.db.run("INSERT INTO threads VALUES(?,?)", [child.id, JSON.stringify(child)]);
      store.db.run("INSERT INTO session_forks(child,parent,data) VALUES(?,?,?)", [
        child.id,
        sourceThreadId,
        JSON.stringify(fork),
      ]);
      store.db.run(
        "INSERT INTO round_executors(round,instance,version,model) SELECT ?,e.instance,e.version,e.model FROM round_executors e JOIN rounds r ON r.id=e.round WHERE json_extract(r.data,'$.threadId')=? AND r.rowid<=(SELECT rowid FROM rounds WHERE id=?) ORDER BY r.rowid DESC LIMIT 1",
        [fork.firstRoundId, sourceThreadId, sourceRoundId],
      );
      store.sync.record([{ objectType: "thread", value: child }]);
      return { kind: "threadForked", fork };
    },
    ["thread.view"],
  );
}
export function readForkRelationships(ctx: FirstSendContext, threadId: ThreadId) {
  const canRead = (id: ThreadId) =>
    ctx.actor.environmentId === ctx.transaction.writer.environmentId &&
    ctx.actor.allows("thread.view", { kind: "thread", threadId: id });
  if (!canRead(threadId)) return reject(ctx.commandId, "notFound");
  const rows = ctx.transaction.db
    .query<{ data: string }, [string, string]>(
      "SELECT data FROM session_forks WHERE child=? OR parent=? ORDER BY rowid",
    )
    .all(threadId, threadId);
  const relationships: WorkRelationship[] = [];
  let fork: ForkTransfer | null = null;
  for (const row of rows) {
    const item = v.parse(ForkTransferSchema, JSON.parse(row.data));
    if (!canRead(item.source.threadId) || !canRead(item.targetThreadId)) continue;
    relationships.push({
      kind: "fork",
      sideChat: false,
      parentThreadId: item.source.threadId,
      sourceRoundId: item.source.roundId,
      targetThreadId: item.targetThreadId,
    });
    if (item.targetThreadId === threadId) fork = item;
  }
  return {
    kind: "accepted",
    commandId: ctx.commandId,
    result: { kind: "threadRelationships", relationships, fork },
  } as const;
}
