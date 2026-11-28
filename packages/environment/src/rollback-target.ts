import { relative, isAbsolute, sep } from "node:path";
import * as v from "valibot";
import {
  CheckpointCaptureSchema,
  DirectoryBindingSchema,
  type DialogueRollbackTarget,
  type Round,
  type Thread,
  type ThreadId,
} from "@kraka/protocol";
import { readRound, readThread, type FirstSendStore } from "./first-send-store";
import { physicalDirectory } from "./project-directory";
import { frozenInput } from "./input-store";
import { savedBinding } from "./executor-bindings";

export function activeRounds(store: FirstSendStore, thread: ThreadId) {
  return store.db
    .query<{ id: string }, [string]>(
      "SELECT id FROM rounds WHERE json_extract(data,'$.threadId')=? AND json_extract(data,'$.rolledBackBy') IS NULL ORDER BY rowid",
    )
    .all(thread)
    .map((r) => readRound(store.db, r.id)!);
}
export function affectedRounds(rounds: Round[], target: DialogueRollbackTarget) {
  const index = rounds.findIndex((r) => r.id === target.roundId);
  return index < 0 ? [] : rounds.slice(index + Number(target.boundary === "after"));
}
export function targetIdentity(store: FirstSendStore, target: DialogueRollbackTarget) {
  const thread = readThread(store.db, target.threadId);
  const round = readRound(store.db, target.roundId);
  if (!thread || round?.threadId !== thread.id || round.attempt.attemptId !== target.attemptId)
    return null;
  const phase = round.attempt.phase;
  if (phase.kind !== "finished") return null;
  if (!("captureId" in target)) {
    const native = frozenInput(store, round.attempt.deliveryId)?.target;
    if (
      thread.directory ||
      thread.worktreeId ||
      phase.root.id !== target.nativeRootTurnId ||
      phase.root.sessionId !== target.nativeSessionId ||
      native?.nativeSessionId !== target.nativeSessionId
    )
      return null;
    return { thread, round, capture: null, binding: null };
  }
  if (phase.captureId !== target.captureId) return null;
  const row = store.db
    .query<{ payload: string }, [string, string]>(
      "SELECT payload FROM sync_rows WHERE source=? AND key=? AND payload IS NOT NULL",
    )
    .get(thread.id, JSON.stringify(["checkpointCapture", target.captureId]));
  if (!row) return null;
  const capture = v.parse(CheckpointCaptureSchema, JSON.parse(row.payload).value);
  const binding = thread.directory;
  if (
    !binding ||
    capture.attemptId !== target.attemptId ||
    capture.roundId !== round.id ||
    capture.id !== target.captureId
  )
    return null;
  if (
    "directoryId" in target
      ? binding.kind !== "projectRoot" ||
        target.directoryId !== binding.directoryId ||
        target.generation !== binding.generation
      : binding.kind !== "managedWorktree" || target.worktreeId !== binding.worktreeId
  )
    return null;
  const saved = store.db
    .query<{ binding: string }, [string]>(
      "SELECT s.binding FROM round_captures c JOIN capture_sources s ON s.id=c.source WHERE c.id=?",
    )
    .get(capture.id);
  if (saved && !Bun.deepEquals(v.parse(DirectoryBindingSchema, JSON.parse(saved.binding)), binding))
    return null;
  return { thread, round, capture, binding };
}
function contains(parent: string, path: string) {
  const part = relative(parent, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(".." + sep);
}
export function overlaps(left: string, right: string) {
  return contains(left, right) || contains(right, left);
}
export function exclusiveCheckout(store: FirstSendStore, thread: Thread) {
  const directory = store.directory(thread);
  if (!directory) return false;
  const path = physicalDirectory(directory);
  if (!path) return false;
  const external = store.db
    .query<{ path: string }, []>(
      "SELECT path FROM managed_worktrees WHERE json_extract(data,'$.active') IS NOT NULL OR json_extract(data,'$.claim.gitChild') IS NOT NULL OR json_extract(data,'$.inspection')=1",
    )
    .all();
  if (external.some((writer) => overlaps(writer.path, path.realPath))) return false;
  // An archived or settled thread can still have a live or unobserved executor.
  const consumers = store.db
    .query<{ id: string }, [string]>(`SELECT id FROM threads t WHERE id<>? AND (
    (json_extract(data,'$.lifecycle.archivedAt') IS NULL AND json_extract(data,'$.lifecycle.state.kind')='active')
    OR EXISTS (SELECT 1 FROM rounds r WHERE json_extract(r.data,'$.threadId')=t.id AND json_extract(r.data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered','filed')))`)
    .all(thread.id);
  for (const row of consumers) {
    const other = readThread(store.db, row.id);
    if (!other?.directory) continue;
    if (other.directory.directoryId === thread.directory?.directoryId) return false;
    const otherPath = store.directory(other);
    if (!otherPath) return false;
    const physical = physicalDirectory(otherPath);
    if (
      !physical ||
      physical.identity === path.identity ||
      overlaps(physical.realPath, path.realPath)
    )
      return false;
  }
  return !store.db
    .query(
      "SELECT 1 FROM rounds WHERE json_extract(data,'$.threadId')=? AND json_extract(data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered') LIMIT 1",
    )
    .get(thread.id);
}
export function nativeBoundary(store: FirstSendStore, target: DialogueRollbackTarget) {
  const rounds = activeRounds(store, target.threadId);
  if (
    rounds.some((r) => !["finished", "endedEarly", "notDelivered"].includes(r.attempt.phase.kind))
  )
    return null;
  const at = rounds.findIndex((r) => r.id === target.roundId);
  const original = rounds[at];
  const saved = savedBinding(store, target.threadId);
  if (
    !original ||
    !saved ||
    original.attempt.phase.kind !== "finished" ||
    original.attempt.phase.root.sessionId !== saved.nativeSessionId
  )
    return null;
  const roots = rounds.flatMap((r) => {
    const phase = r.attempt.phase;
    return "root" in phase && phase.root.sessionId === saved.nativeSessionId
      ? [{ roundId: r.id, root: phase.root.id }]
      : [];
  });
  const index = roots.findIndex((r) => r.roundId === target.roundId);
  if (index < 0 || !roots.length) return null;
  return {
    binding: saved,
    roots: roots.map((r) => r.root),
    keep: index + Number(target.boundary === "after"),
  };
}
