import type {
  AttemptId,
  CaptureId,
  CheckpointCapture,
  CommandId,
  FileChange,
  FileOwnership,
  GitObjectId,
  RollbackPart,
  RollbackProgress,
  RollbackTarget,
  DialogueRollbackTarget,
  ThreadId,
  WorktreeId,
  DirectoryBinding,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";

export type CaptureKey = Pick<CheckpointCapture, "id" | "roundId" | "attemptId"> & {
  threadId: ThreadId;
  writer?: string;
  environmentId?: import("@kraka/protocol").EnvironmentId;
  worktreeId: WorktreeId | null;
  projectRoot?: Extract<DirectoryBinding, { kind: "projectRoot" }>;
};
export const CAPTURE_BOUNDARY_TIMEOUT_MS = 5000;
export type Boundary = "before" | "after";
/** Git writes this operation's private index and publishes its commit under the boundary ref. */
export type CaptureWorkspace = {
  ref: string;
  privateIndexPath: string;
  privateObjectDirectory: string;
  compareFrom: GitObjectId | null;
};
export type PublishedBoundary = { ref: string; commit: GitObjectId; tree: GitObjectId };
export type CaptureState = { key: CaptureKey } & (
  | { kind: "before" }
  | { kind: "working" | "after"; baseline: PublishedBoundary }
  | {
      kind: "settled";
      baseline: PublishedBoundary | null;
      end: PublishedBoundary | null;
      files: readonly FileChange[] | null;
      capture: CheckpointCapture;
    }
);
export function beginCapture(key: CaptureKey): CaptureState {
  return { key, kind: "before" };
}

/** A committed operation ID survives a restart. Removing a thread releases its refs; unreachable objects follow Git GC. */
export function checkpointRef(
  key: Pick<CaptureKey, "environmentId" | "threadId" | "id" | "writer">,
  boundary: Boundary,
): string {
  return [
    "refs/kraka/checkpoints",
    ...(key.writer
      ? [key.writer]
      : key.environmentId
        ? [new Bun.CryptoHasher("sha256").update(key.environmentId).digest("hex")]
        : []),
    new Bun.CryptoHasher("sha256").update(key.threadId).digest("hex"),
    new Bun.CryptoHasher("sha256").update(key.id).digest("hex"),
    boundary,
  ].join("/");
}

export type CaptureLayout = "compact" | "legacy";
export function captureDirectory(
  key: Pick<CaptureKey, "id" | "threadId" | "environmentId">,
  boundary: Boundary,
  layout: CaptureLayout = "compact",
) {
  // Scratch already lives under the writer state. Keep its address across ref-format upgrades.
  const { environmentId, threadId, id } = key;
  const ref = checkpointRef({ ...(environmentId && { environmentId }), threadId, id }, boundary);
  return layout === "legacy"
    ? ref.slice("refs/kraka/".length)
    : new Bun.CryptoHasher("sha256").update(ref).digest("hex");
}

/** Paths are relative to the environment's scratch root. Probe the published ref before repeating work on restart. */
export function captureWorkspace(
  state: CaptureState,
  layout: CaptureLayout = "compact",
): CaptureWorkspace | null {
  if (
    (state.kind !== "before" && state.kind !== "after") ||
    !(state.key.worktreeId || state.key.projectRoot)
  )
    return null;
  const ref = checkpointRef(state.key, state.kind);
  const directory = captureDirectory(state.key, state.kind, layout);
  return {
    ref,
    privateIndexPath: `${directory}/index`,
    privateObjectDirectory: `${directory}/objects`,
    compareFrom: state.kind === "after" ? state.baseline.tree : null,
  };
}

type Writer = Extract<FileOwnership, { kind: "observed" }>;
export type PathObservation = Omit<Writer, "kind"> & { path: string };
/** Observations cover this path in the same worktree between the two published boundaries. */
export function attributeFile(
  path: string,
  observations: readonly PathObservation[],
  coverage: "complete" | "sharedWriter",
): FileOwnership {
  const writers = observations.filter((w) => w.path === path);
  const first = writers[0];
  if (!first || coverage === "sharedWriter")
    return {
      kind: "unknown",
      reason: coverage === "sharedWriter" ? "sharedWriter" : "noObservation",
    };
  if (
    writers.some(
      (w) =>
        w.attemptId !== first.attemptId ||
        w.roundId !== first.roundId ||
        w.threadId !== first.threadId,
    )
  )
    return { kind: "unknown", reason: "overlap" };
  return {
    kind: "observed",
    threadId: first.threadId,
    roundId: first.roundId,
    attemptId: first.attemptId,
    itemId: first.itemId,
  };
}
export type CaptureEvent = { id: CaptureId; attemptId: AttemptId } & (
  | { kind: "baselinePublished"; point: PublishedBoundary }
  | { kind: "rootEnded" }
  | {
      kind: "endPublished";
      point: PublishedBoundary;
      version: CheckpointCapture["version"];
      comparison:
        | { kind: "compared"; files: readonly FileChange[] }
        | { kind: "unknown"; reason: string };
    }
  | {
      kind: "missing" | "error";
      boundary: Boundary;
      reason: string;
      version: CheckpointCapture["version"];
    }
);

/** Publishing and recording are separate. Recovery reads the same ref and feeds the same event back here. */
export function transitionCapture(
  state: CaptureState,
  event: CaptureEvent,
): TransitionResult<CaptureState> {
  const key = state.key;
  if (event.id !== key.id) return reject("wrongCapture");
  if (event.attemptId !== key.attemptId) return reject("wrongAttempt");
  if (state.kind === "settled") return ok(state);
  switch (event.kind) {
    case "baselinePublished":
      if (!(key.worktreeId || key.projectRoot) || event.point.ref !== checkpointRef(key, "before"))
        return reject("wrongCapture");
      if (state.kind !== "before")
        return state.baseline.commit === event.point.commit ? ok(state) : reject("idConflict");
      return ok({ key, kind: "working", baseline: event.point });
    case "rootEnded":
      if (state.kind === "after") return ok(state);
      return state.kind === "working" ? ok({ ...state, kind: "after" }) : reject("invalidState");
    case "endPublished": {
      if (state.kind !== "after") return reject("invalidState");
      if (!(key.worktreeId || key.projectRoot) || event.point.ref !== checkpointRef(key, "after"))
        return reject("wrongCapture");
      const comparison = event.comparison;
      const summary =
        comparison.kind === "unknown"
          ? comparison
          : comparison.files.length
            ? { kind: "changed" as const, fileCount: comparison.files.length }
            : { kind: "empty" as const };
      const result = {
        kind: "ready" as const,
        ...(key.projectRoot
          ? { directoryId: key.projectRoot.directoryId, generation: key.projectRoot.generation }
          : { worktreeId: key.worktreeId! }),
        comparison: { before: state.baseline.commit, after: event.point.commit, summary },
      };
      return ok({
        kind: "settled",
        key,
        baseline: state.baseline,
        end: event.point,
        files: comparison.kind === "compared" ? comparison.files : null,
        capture: {
          id: key.id,
          roundId: key.roundId,
          attemptId: key.attemptId,
          version: event.version,
          result,
        },
      });
    }
    case "error":
    case "missing":
      if (state.kind !== event.boundary) return reject("invalidState");
      return ok({
        kind: "settled",
        key,
        baseline: state.kind === "after" ? state.baseline : null,
        end: null,
        files: null,
        capture: {
          id: key.id,
          roundId: key.roundId,
          attemptId: key.attemptId,
          version: event.version,
          result: { kind: event.kind, reason: event.reason, boundary: event.boundary },
        },
      });
    default:
      return unexpected(event);
  }
}

export function beginRollback(
  commandId: CommandId,
  target: RollbackTarget,
  mode: "dialogue" | "files" | "both",
): RollbackProgress;
export function beginRollback(
  commandId: CommandId,
  target: DialogueRollbackTarget,
  mode: "dialogue",
): RollbackProgress;
export function beginRollback(
  commandId: CommandId,
  target: DialogueRollbackTarget,
  mode: "dialogue" | "files" | "both",
): RollbackProgress {
  if (!("captureId" in target)) {
    if (mode !== "dialogue") throw new Error("Restoring files requires a worktree");
    return {
      commandId,
      target,
      dialogue: { kind: "pending", execution: 1 },
      files: { kind: "notRequested" },
    };
  }
  return {
    commandId,
    target,
    dialogue: mode === "files" ? { kind: "notRequested" } : { kind: "pending", execution: 1 },
    files: mode === "dialogue" ? { kind: "notRequested" } : { kind: "pending", execution: 1 },
  };
}
export type RollbackEvent = {
  commandId: CommandId;
  part: "files" | "dialogue";
  execution: number;
} & (
  | { kind: "claim"; part: "dialogue" }
  | { kind: "claim"; part: "files"; capture: CheckpointCapture; exclusive: boolean }
  | { kind: "preflightFailed"; part: "files"; reason: string; retryable: boolean }
  | { kind: "retry" }
  | Extract<RollbackPart, { kind: "succeeded" | "failed" | "unknown" }>
  | { kind: "verified"; finding: "applied" | "absentAfterFence" }
);
/** Each leg has its own effect identity (command ID, part). Reconcile an uncertain effect before another attempt. */
export function transitionRollback(
  state: RollbackProgress,
  event: RollbackEvent,
): TransitionResult<RollbackProgress> {
  if (event.commandId !== state.commandId) return reject("wrongRequest");
  const current = state[event.part];
  if (current.kind === "notRequested") return reject("invalidState");
  const { execution } = current;
  if (event.execution !== execution) return reject("wrongAttempt");
  const set = (value: RollbackPart) => ok({ ...state, [event.part]: value });
  switch (event.kind) {
    case "claim": {
      if (current.kind !== "pending") return reject("invalidState");
      if (event.part === "files") {
        const { target } = state,
          { capture } = event;
        if (
          !("captureId" in target) ||
          capture.id !== target.captureId ||
          capture.roundId !== target.roundId ||
          capture.attemptId !== target.attemptId
        )
          return reject("wrongCapture");
        if (!event.exclusive)
          return set({ kind: "failed", execution, reason: "sharedWorkspace", retryable: true });
        if (
          capture.result.kind !== "ready" ||
          !("directoryId" in target
            ? "directoryId" in capture.result &&
              capture.result.directoryId === target.directoryId &&
              capture.result.generation === target.generation
            : "worktreeId" in capture.result && capture.result.worktreeId === target.worktreeId) ||
          !capture.result.comparison
        )
          return set({
            kind: "failed",
            execution,
            reason: "checkpointUnavailable",
            retryable: false,
          });
      }
      return set({ kind: "running", execution });
    }
    case "preflightFailed":
      return current.kind === "pending"
        ? set({ kind: "failed", reason: event.reason, retryable: event.retryable, execution })
        : reject("invalidState");
    case "retry":
      return current.kind === "failed" && current.retryable
        ? set({ kind: "pending", execution: execution + 1 })
        : reject("invalidState");
    case "verified":
      return current.kind === "unknown"
        ? set(
            event.finding === "applied"
              ? { kind: "succeeded", execution }
              : { kind: "pending", execution: execution + 1 },
          )
        : reject("invalidState");
    case "succeeded":
      return current.kind === "succeeded"
        ? ok(state)
        : current.kind === "running"
          ? set({ kind: "succeeded", execution })
          : reject("invalidState");
    case "failed":
      return current.kind === "running"
        ? set({ kind: "failed", execution, reason: event.reason, retryable: event.retryable })
        : reject("invalidState");
    case "unknown":
      return current.kind === "running"
        ? set({ kind: "unknown", execution, reason: event.reason })
        : reject("invalidState");
    default:
      return unexpected(event);
  }
}
