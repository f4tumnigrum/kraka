import * as v from "valibot";
import {
  EnvironmentIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  WorktreeIdSchema,
  WorktreeGenerationSchema,
  SubscriptionIdSchema,
} from "./ids";
import { GitObjectIdSchema, WorkspaceRelativePathSchema } from "./git-types";

const text = v.pipe(v.string(), v.minLength(1));
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const WORKSPACE_FILE_READ_LIMIT_BYTES = 1_048_576;
const returnedBytes = v.pipe(count, v.maxValue(WORKSPACE_FILE_READ_LIMIT_BYTES));
const digest = v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/));
const directoryId = text;
export const RepositoryIdentitySchema = v.strictObject({
  host: v.pipe(text, v.regex(/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/)),
  port: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535))),
  path: text,
});
export const ProjectRootSchema = v.strictObject({
  directoryId,
  generation: WorktreeGenerationSchema,
  realPath: text,
  repository: v.nullable(RepositoryIdentitySchema),
  origin: v.nullable(RepositoryIdentitySchema),
  relativeToCheckout: v.nullable(v.string()),
});
const common = { directoryId, generation: WorktreeGenerationSchema };
export const DirectoryBindingSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("projectRoot"), ...common }),
  v.strictObject({
    kind: v.literal("managedWorktree"),
    ...common,
    worktreeId: WorktreeIdSchema,
    ownerThreadId: ThreadIdSchema,
  }),
  v.strictObject({ kind: v.literal("temporary"), ...common, ownerThreadId: ThreadIdSchema }),
]);
export type DirectoryBinding = v.InferOutput<typeof DirectoryBindingSchema>;
/** Threads sharing a directory reference one durable identity and generation. */
export const DirectoryRecordSchema = v.strictObject({
  binding: DirectoryBindingSchema,
  projectId: ProjectIdSchema,
  environmentId: EnvironmentIdSchema,
  realPath: text,
});
export type DirectoryRecord = v.InferOutput<typeof DirectoryRecordSchema>;
export const WorkspaceTargetSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("project"), projectId: ProjectIdSchema, ...common }),
  v.strictObject({ kind: v.literal("thread"), threadId: ThreadIdSchema, ...common }),
]);
export const GitGranularitySchema = v.picklist(["branch", "detailed"]);
const head = v.variant("kind", [
  v.strictObject({ kind: v.literal("branch"), name: text, tip: v.nullable(GitObjectIdSchema) }),
  v.strictObject({ kind: v.literal("detached"), tip: GitObjectIdSchema }),
]);
const pathChange = v.strictObject({
  path: WorkspaceRelativePathSchema,
  status: text,
  insertions: v.nullable(count),
  deletions: v.nullable(count),
});
const remote = v.variant("kind", [
  v.strictObject({ kind: v.literal("unverified") }),
  v.strictObject({ kind: v.literal("verified"), upstream: text, ahead: count, behind: count }),
]);
const gitAddress = { target: WorkspaceTargetSchema, sequence: count };
export const GitStatusSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("notRepository"),
    ...gitAddress,
    granularity: GitGranularitySchema,
  }),
  v.strictObject({
    kind: v.literal("invalidated"),
    ...gitAddress,
    granularity: GitGranularitySchema,
  }),
  v.strictObject({ kind: v.literal("branch"), ...gitAddress, head }),
  v.strictObject({
    kind: v.literal("detailed"),
    ...gitAddress,
    head,
    staged: v.array(pathChange),
    unstaged: v.array(pathChange),
    untracked: v.array(WorkspaceRelativePathSchema),
    remote,
  }),
]);
const gitRequest = { target: WorkspaceTargetSchema, granularity: GitGranularitySchema };
export const GitStatusRequestSchema = v.strictObject(gitRequest);
export const GitSubscribeSchema = v.strictObject({
  ...gitRequest,
  subscriptionId: SubscriptionIdSchema,
  streamId: v.pipe(count, v.minValue(1), v.maxValue(2147483647)),
});
const path = WorkspaceRelativePathSchema;
const address = { target: WorkspaceTargetSchema, path };
export const BrowseWorkspaceSchema = v.strictObject({
  target: WorkspaceTargetSchema,
  directory: v.nullable(path),
  after: v.nullable(text),
});
export const ReadWorkspaceFileSchema = v.strictObject(address);
export const WorkspaceFileReadSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("complete"),
    ...address,
    text: v.string(),
    bytes: returnedBytes,
    digest,
  }),
  v.strictObject({
    kind: v.literal("truncated"),
    ...address,
    prefix: v.string(),
    readBytes: returnedBytes,
    totalBytes: count,
  }),
]);
export const SearchWorkspaceSchema = v.strictObject({
  target: WorkspaceTargetSchema,
  mode: v.picklist(["name", "content"]),
  query: text,
  after: v.nullable(text),
});
const contentHit = v.strictObject({
  kind: v.literal("content"),
  path,
  line: v.pipe(count, v.minValue(1)),
  column: v.pipe(count, v.minValue(1)),
  preview: v.string(),
});
const hit = v.union([
  contentHit,
  v.strictObject({ kind: v.literal("name"), path, entryKind: v.picklist(["file", "directory"]) }),
]);
export const WorkspaceSearchResultSchema = v.variant("coverage", [
  v.strictObject({ coverage: v.literal("complete"), hits: v.array(hit) }),
  v.strictObject({
    coverage: v.literal("partial"),
    hits: v.array(hit),
    next: v.nullable(text),
    reason: text,
  }),
]);
export const WorkspaceDirectorySchema = v.strictObject({
  entries: v.array(v.strictObject({ name: text, kind: v.picklist(["file", "directory"]) })),
  next: v.nullable(text),
});
export const WriteWorkspaceFileSchema = v.strictObject({
  ...address,
  text: v.string(),
  bytes: count,
  digest,
  expected: v.variant("kind", [
    v.strictObject({ kind: v.literal("absent") }),
    v.strictObject({ kind: v.literal("complete"), digest }),
  ]),
});
export const WorkspaceWriteResultSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("verified"), ...address, digest, bytes: count }),
  v.strictObject({ kind: v.picklist(["conflict", "unknown"]), ...address, reason: text }),
]);
export type GitStatus = v.InferOutput<typeof GitStatusSchema>;
export type WorkspaceFileRead = v.InferOutput<typeof WorkspaceFileReadSchema>;

/** Resolve the grant on the project or thread. The directory identity must independently match its live binding. */
export function workspaceAuthorizationTarget(target: v.InferOutput<typeof WorkspaceTargetSchema>) {
  return target.kind === "project"
    ? { kind: "project" as const, projectId: target.projectId }
    : { kind: "thread" as const, threadId: target.threadId };
}
