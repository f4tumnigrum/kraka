import * as v from "valibot";
import {
  AttemptIdSchema,
  CaptureIdSchema,
  CommandIdSchema,
  NativeItemIdSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  RoundIdSchema,
  ThreadIdSchema,
  WorktreeGenerationSchema,
  WorktreeIdSchema,
} from "./ids";

import { GitObjectIdSchema, WorkspaceRelativePathSchema } from "./git-types";
export { GitObjectIdSchema, WorkspaceRelativePathSchema, type GitObjectId } from "./git-types";
import { ForgeProofSchema } from "./forge";
export const FileOwnershipSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("observed"),
    threadId: ThreadIdSchema,
    roundId: RoundIdSchema,
    attemptId: AttemptIdSchema,
    itemId: NativeItemIdSchema,
  }),
  v.strictObject({
    kind: v.literal("unknown"),
    reason: v.picklist(["noObservation", "sharedWriter", "overlap"]),
  }),
]);
export type FileOwnership = v.InferOutput<typeof FileOwnershipSchema>;
export const FileChangeSchema = v.strictObject({
  path: WorkspaceRelativePathSchema,
  previousPath: v.nullable(WorkspaceRelativePathSchema),
  change: v.picklist(["added", "modified", "removed", "renamed"]),
  owner: FileOwnershipSchema,
});
export type FileChange = v.InferOutput<typeof FileChangeSchema>;
const unavailableReason = v.pipe(v.string(), v.minLength(1));
export const ChangeSummarySchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("unknown"), reason: unavailableReason }),
  v.strictObject({ kind: v.literal("empty") }),
  v.strictObject({
    kind: v.literal("changed"),
    fileCount: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  }),
]);
export type ChangeSummary = v.InferOutput<typeof ChangeSummarySchema>;
export const CheckpointComparisonSchema = v.strictObject({
  before: GitObjectIdSchema,
  after: GitObjectIdSchema,
  summary: ChangeSummarySchema,
});
const directoryAddress = {
  directoryId: v.pipe(v.string(), v.minLength(1)),
  generation: WorktreeGenerationSchema,
};
const boundary = v.picklist(["before", "after"]);
export const CheckpointResultSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("ready"),
    worktreeId: WorktreeIdSchema,
    comparison: v.optional(CheckpointComparisonSchema),
  }),
  v.strictObject({
    kind: v.literal("ready"),
    ...directoryAddress,
    comparison: v.optional(CheckpointComparisonSchema),
  }),
  v.strictObject({
    kind: v.literal("missing"),
    boundary: v.optional(boundary),
    reason: v.optional(unavailableReason),
  }),
  v.strictObject({
    kind: v.literal("error"),
    reason: unavailableReason,
    boundary: v.optional(boundary),
  }),
]);
export type CheckpointResult = v.InferOutput<typeof CheckpointResultSchema>;

/** Older captures have no recorded summary. Only a completed comparison establishes an empty diff. */
export function checkpointSummary(result: CheckpointResult): ChangeSummary {
  if (result.kind === "ready" && result.comparison) return result.comparison.summary;
  return {
    kind: "unknown",
    reason: result.kind === "ready" ? "summaryUnavailable" : (result.reason ?? "captureMissing"),
  };
}

const local = { threadId: ThreadIdSchema, worktreeId: WorktreeIdSchema };
const projectRoot = {
  threadId: ThreadIdSchema,
  ...directoryAddress,
};
export const DiffRequestSchema = v.union([
  v.strictObject({
    ...local,
    kind: v.literal("roundRange"),
    fromCaptureId: CaptureIdSchema,
    toCaptureId: CaptureIdSchema,
  }),
  v.strictObject({ ...local, kind: v.literal("round"), captureId: CaptureIdSchema }),
  v.strictObject({ ...projectRoot, kind: v.literal("round"), captureId: CaptureIdSchema }),
  v.strictObject({
    ...projectRoot,
    kind: v.literal("roundRange"),
    fromCaptureId: CaptureIdSchema,
    toCaptureId: CaptureIdSchema,
  }),
  v.strictObject({ ...local, kind: v.literal("workingTree") }),
  v.strictObject({ ...projectRoot, kind: v.literal("workingTree") }),
  v.strictObject({
    ...local,
    kind: v.literal("branch"),
    baseRef: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({
    ...projectRoot,
    kind: v.literal("branch"),
    baseRef: v.pipe(v.string(), v.minLength(1)),
  }),
  v.strictObject({ ...local, kind: v.literal("commit"), commit: GitObjectIdSchema }),
  v.strictObject({ ...projectRoot, kind: v.literal("commit"), commit: GitObjectIdSchema }),
]);
export const DiffEndpointSchema = v.union([
  v.strictObject({
    kind: v.literal("git"),
    worktreeId: WorktreeIdSchema,
    relation: v.picklist(["mergeBase", "head", "firstParent", "commit", "emptyTree"]),
    oid: GitObjectIdSchema,
  }),
  v.strictObject({
    kind: v.literal("git"),
    ...projectRoot,
    relation: v.picklist(["mergeBase", "head", "firstParent", "commit", "emptyTree"]),
    oid: GitObjectIdSchema,
  }),
  v.strictObject({
    kind: v.literal("workingTree"),
    worktreeId: WorktreeIdSchema,
    tree: GitObjectIdSchema,
  }),
  v.strictObject({
    kind: v.literal("workingTree"),
    ...projectRoot,
    tree: GitObjectIdSchema,
  }),
  v.strictObject({
    kind: v.literal("round"),
    captureId: CaptureIdSchema,
    boundary,
    commit: GitObjectIdSchema,
  }),
]);
const endpoints = { from: DiffEndpointSchema, to: DiffEndpointSchema };
export const DiffResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("empty"), ...endpoints }),
  v.strictObject({
    kind: v.literal("changed"),
    ...endpoints,
    files: v.tupleWithRest([FileChangeSchema], FileChangeSchema),
    patch: v.string(),
    truncated: v.optional(v.boolean()),
    next: v.nullable(v.string()),
  }),
  v.strictObject({
    kind: v.literal("unavailable"),
    request: DiffRequestSchema,
    from: v.nullable(DiffEndpointSchema),
    to: v.nullable(DiffEndpointSchema),
    reason: unavailableReason,
  }),
]);
export type DiffRequest = v.InferOutput<typeof DiffRequestSchema>;
export type DiffResult = v.InferOutput<typeof DiffResultSchema>;

const rollbackBoundary = {
  roundId: RoundIdSchema,
  attemptId: AttemptIdSchema,
  captureId: CaptureIdSchema,
  boundary,
};
export const RollbackTargetSchema = v.union([
  v.strictObject({ ...local, ...rollbackBoundary }),
  v.strictObject({ ...projectRoot, ...rollbackBoundary }),
]);
export const DialogueRollbackTargetSchema = v.union([
  RollbackTargetSchema,
  v.strictObject({
    threadId: ThreadIdSchema,
    roundId: RoundIdSchema,
    attemptId: AttemptIdSchema,
    worktreeId: v.null(),
    nativeSessionId: NativeSessionIdSchema,
    nativeRootTurnId: NativeRootTurnIdSchema,
    boundary,
  }),
]);
export type RollbackTarget = v.InferOutput<typeof RollbackTargetSchema>;
export type DialogueRollbackTarget = v.InferOutput<typeof DialogueRollbackTargetSchema>;
const execution = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
export const RollbackPartSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("notRequested") }),
  v.strictObject({ kind: v.literal("pending"), execution }),
  v.strictObject({ kind: v.literal("running"), execution }),
  v.strictObject({ kind: v.literal("succeeded"), execution }),
  v.strictObject({
    kind: v.literal("failed"),
    execution,
    reason: unavailableReason,
    retryable: v.boolean(),
  }),
  v.strictObject({ kind: v.literal("unknown"), execution, reason: unavailableReason }),
]);
export type RollbackPart = v.InferOutput<typeof RollbackPartSchema>;
const progress = {
  commandId: CommandIdSchema,
  externalEffects: v.optional(
    v.array(
      v.strictObject({
        operationId: CommandIdSchema,
        attemptId: AttemptIdSchema,
        proof: ForgeProofSchema,
      }),
    ),
  ),
  dialogue: RollbackPartSchema,
};
export const RollbackProgressSchema = v.union([
  v.strictObject({ ...progress, target: RollbackTargetSchema, files: RollbackPartSchema }),
  v.strictObject({
    ...progress,
    target: DialogueRollbackTargetSchema.options[1],
    files: RollbackPartSchema.options[0],
  }),
]);
export type RollbackProgress = v.InferOutput<typeof RollbackProgressSchema>;
export const checkpointSchemas = {
  GitObjectId: GitObjectIdSchema,
  FileOwnership: FileOwnershipSchema,
  FileChange: FileChangeSchema,
  ChangeSummary: ChangeSummarySchema,
  CheckpointComparison: CheckpointComparisonSchema,
  CheckpointResult: CheckpointResultSchema,
  DiffRequest: DiffRequestSchema,
  DiffEndpoint: DiffEndpointSchema,
  DiffResult: DiffResultSchema,
  RollbackTarget: RollbackTargetSchema,
  DialogueRollbackTarget: DialogueRollbackTargetSchema,
  RollbackPart: RollbackPartSchema,
  RollbackProgress: RollbackProgressSchema,
};
