import * as v from "valibot";
import {
  AttemptIdSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  WorktreeGenerationSchema,
  WorktreeIdSchema,
} from "./ids";
import { GitObjectIdSchema } from "./checkpoints";

const name = v.pipe(v.string(), v.minLength(1));
const prior = v.variant("kind", [
  v.strictObject({ kind: v.literal("first") }),
  v.strictObject({
    kind: v.literal("rebuild"),
    previousHead: v.nullable(GitObjectIdSchema),
    oldFiles: v.literal("notRestored"),
  }),
]);
export const WorktreeOriginSchema = v.union([
  v.strictObject({
    kind: v.picklist(["selected", "localBranch", "remoteTracking", "projectHead"]),
    ref: name,
    commit: GitObjectIdSchema,
    prior,
  }),
  v.strictObject({ kind: v.literal("empty"), prior }),
]);
export type WorktreeOrigin = v.InferOutput<typeof WorktreeOriginSchema>;
export const WorktreeSetupSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("queued") }),
  v.strictObject({ kind: v.literal("started"), attemptId: AttemptIdSchema }),
  v.strictObject({ kind: v.literal("unknown"), attemptId: AttemptIdSchema }),
  v.strictObject({ kind: v.literal("failed"), attemptId: AttemptIdSchema, reason: name }),
]);
const origin = WorktreeOriginSchema;
const ready = v.strictObject({
  kind: v.literal("ready"),
  origin,
  setup: v.picklist(["passed", "skipped"]),
});
export const WorktreePhaseSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("absent"), previousHead: v.nullable(GitObjectIdSchema) }),
  v.strictObject({ kind: v.literal("building"), origin }),
  v.strictObject({ kind: v.literal("preparing"), origin, script: WorktreeSetupSchema }),
  ready,
  v.strictObject({
    kind: v.literal("removing"),
    saved: ready,
    checkedHead: v.nullable(GitObjectIdSchema),
  }),
]);
export type WorktreePhase = v.InferOutput<typeof WorktreePhaseSchema>;
export const WorktreeAddressSchema = v.strictObject({
  environmentId: EnvironmentIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  threadId: ThreadIdSchema,
});
export type WorktreeAddress = v.InferOutput<typeof WorktreeAddressSchema>;
export const WorktreeStatusSchema = v.strictObject({
  ...WorktreeAddressSchema.entries,
  branch: name,
  generation: WorktreeGenerationSchema,
  operationId: CommandIdSchema,
  phase: WorktreePhaseSchema,
});
export type WorktreeStatus = v.InferOutput<typeof WorktreeStatusSchema>;
export const WorktreeViewSchema = v.strictObject({
  status: WorktreeStatusSchema,
  availability: v.picklist(["usable", "unavailable", "needsInspection"]),
});
export type WorktreeView = v.InferOutput<typeof WorktreeViewSchema>;
export const WorktreeRetainedSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("occupied") }),
  v.strictObject({ kind: v.literal("files"), paths: v.tupleWithRest([name], name) }),
  v.strictObject({ kind: v.literal("unpublished") }),
  v.strictObject({ kind: v.literal("uncertain") }),
]);
export type WorktreeRetained = v.InferOutput<typeof WorktreeRetainedSchema>;
export const WorktreePrepareSchema = v.strictObject({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  worktreeId: WorktreeIdSchema,
  branch: name,
  baseRef: v.nullable(name),
});
export const WorktreeCleanSchema = v.strictObject({
  projectId: ProjectIdSchema,
  threadId: ThreadIdSchema,
  worktreeId: WorktreeIdSchema,
  generation: WorktreeGenerationSchema,
});
export const WorktreeRetrySchema = v.strictObject({
  ...WorktreeCleanSchema.entries,
  previousAttemptId: AttemptIdSchema,
});
export const worktreeSchemas = {
  WorktreeView: WorktreeViewSchema,
  WorktreeGeneration: WorktreeGenerationSchema,
  WorktreeOrigin: WorktreeOriginSchema,
  WorktreePhase: WorktreePhaseSchema,
  WorktreeAddress: WorktreeAddressSchema,
  WorktreeStatus: WorktreeStatusSchema,
  WorktreeRetained: WorktreeRetainedSchema,
};
