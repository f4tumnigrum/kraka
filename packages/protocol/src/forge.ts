import * as v from "valibot";
import { GitObjectIdSchema, WorkspaceRelativePathSchema } from "./git-types";
import {
  AttemptIdSchema,
  CommandIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  WorktreeIdSchema,
} from "./ids";

const name = v.pipe(v.string(), v.minLength(1));
const positive = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const instant = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
/** Hosts use their canonical lowercase name; repository identity is the platform's permanent ID. */
export const ForgeRepositorySchema = v.strictObject({
  platform: v.literal("github"),
  host: v.pipe(name, v.regex(/^[a-z0-9.-]+$/)),
  id: name,
});
export type ForgeRepository = v.InferOutput<typeof ForgeRepositorySchema>;
export const ForgeBranchSchema = v.strictObject({ repository: ForgeRepositorySchema, name });
export type ForgeBranch = v.InferOutput<typeof ForgeBranchSchema>;
const pair = { source: ForgeBranchSchema, target: ForgeBranchSchema };
export const ForgePublishSchema = v.strictObject({
  threadId: ThreadIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: WorktreeIdSchema,
  ...pair,
  createBranch: v.boolean(),
  commit: v.nullable(
    v.strictObject({
      paths: v.tupleWithRest([WorkspaceRelativePathSchema], WorkspaceRelativePathSchema),
      message: name,
    }),
  ),
  push: v.boolean(),
  pullRequest: v.nullable(v.strictObject({ title: name, body: v.string() })),
});
export type ForgePublish = v.InferOutput<typeof ForgePublishSchema>;
export const ForgePullSchema = v.strictObject({
  repository: ForgeRepositorySchema,
  number: positive,
});
export type ForgePull = v.InferOutput<typeof ForgePullSchema>;
const branchProof = v.strictObject({
  step: v.literal("branch"),
  checkedOutRef: name,
  branch: ForgeBranchSchema,
  parent: GitObjectIdSchema,
  worktreeId: WorktreeIdSchema,
});
const commitProof = v.strictObject({
  step: v.literal("commit"),
  branch: ForgeBranchSchema,
  worktreeId: WorktreeIdSchema,
  parent: GitObjectIdSchema,
  tree: GitObjectIdSchema,
  inBranchHistory: v.literal(true),
  oid: GitObjectIdSchema,
  paths: v.array(WorkspaceRelativePathSchema),
  priorEdits: v.variant("kind", [
    v.strictObject({ kind: v.literal("unknown") }),
    v.strictObject({ kind: v.literal("known"), paths: v.array(WorkspaceRelativePathSchema) }),
  ]),
});
const pushProof = v.strictObject({
  step: v.literal("push"),
  branch: ForgeBranchSchema,
  tip: GitObjectIdSchema,
  origin: v.picklist(["pushed", "existing", "observed"]),
});
const pullFacts = {
  ...pair,
  number: positive,
  marker: v.nullable(CommandIdSchema),
  currentHead: v.nullable(GitObjectIdSchema),
  verifiedMember: v.nullable(GitObjectIdSchema),
  state: v.picklist(["open", "closed", "merged"]),
};
export const ForgePullMatchSchema = v.strictObject(pullFacts);
export type ForgePullMatch = v.InferOutput<typeof ForgePullMatchSchema>;
const prProof = v.strictObject({
  step: v.literal("pullRequest"),
  ...pullFacts,
  publicationHead: GitObjectIdSchema,
  origin: v.picklist(["created", "existing", "observed"]),
  evidence: v.picklist(["createReply", "knownNumber", "marker", "currentHead", "member"]),
});
export const ForgeProofSchema = v.variant("step", [branchProof, commitProof, pushProof, prProof]);
export type ForgeProof = v.InferOutput<typeof ForgeProofSchema>;
const waiting = v.strictObject({ kind: v.literal("waiting") });
const pullWaiting = v.strictObject({
  ...waiting.entries,
  blocked: v.optional(
    v.strictObject({
      reason: v.picklist(["incompleteListing", "headChanged", "ambiguous", "inconsistentListing"]),
      numbers: v.array(positive),
    }),
  ),
});
function stepState<
  S extends v.GenericSchema,
  R extends v.GenericSchema,
  W extends typeof waiting | typeof pullWaiting,
>(proof: S, skipReason: R, waitingState: W) {
  return v.variant("kind", [
    waitingState,
    v.strictObject({ kind: v.literal("issued"), attemptId: AttemptIdSchema }),
    v.strictObject({ kind: v.literal("verify"), attemptId: AttemptIdSchema, reason: name }),
    v.strictObject({ kind: v.literal("done"), proof }),
    v.strictObject({ kind: v.literal("failed"), reason: name }),
    v.strictObject({ kind: v.literal("skipped"), reason: skipReason }),
  ]);
}
const omitted = v.literal("omitted");
export const ForgeProgressSchema = v.strictObject({
  commandId: CommandIdSchema,
  request: ForgePublishSchema,
  steps: v.strictObject({
    branch: stepState(branchProof, omitted, waiting),
    commit: stepState(commitProof, v.picklist(["omitted", "noChanges"]), waiting),
    push: stepState(pushProof, omitted, waiting),
    pullRequest: stepState(prProof, omitted, pullWaiting),
  }),
});
export type ForgeProgress = v.InferOutput<typeof ForgeProgressSchema>;

export const ForgeFileKeySchema = v.strictObject({
  accountId: name,
  pull: ForgePullSchema,
  headOid: GitObjectIdSchema,
  path: WorkspaceRelativePathSchema,
});
export type ForgeFileKey = v.InferOutput<typeof ForgeFileKeySchema>;
export const ForgeFileValueSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("blob"), oid: GitObjectIdSchema, mode: name }),
  v.strictObject({ kind: v.literal("deleted") }),
]);
export type ForgeFileValue = v.InferOutput<typeof ForgeFileValueSchema>;
export const ForgeReadMarkSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("unmarked") }),
  v.strictObject({ kind: v.literal("noBaseline") }),
  v.strictObject({ kind: v.literal("marked"), value: ForgeFileValueSchema }),
]);
export type ForgeReadMark = v.InferOutput<typeof ForgeReadMarkSchema>;
export const ForgeReadResultSchema = v.union([
  v.strictObject({ kind: v.picklist(["unmarked", "noBaseline", "noAnswer"]) }),
  v.strictObject({
    kind: v.picklist(["equal", "changed"]),
    before: ForgeFileValueSchema,
    now: ForgeFileValueSchema,
  }),
]);
export type ForgeReadResult = v.InferOutput<typeof ForgeReadResultSchema>;
export const ForgeMarkRequestSchema = v.strictObject({
  threadId: ThreadIdSchema,
  file: ForgeFileKeySchema,
  baseVersion: ObjectVersionSchema,
  mark: ForgeReadMarkSchema,
});
export type ForgeMarkRequest = v.InferOutput<typeof ForgeMarkRequestSchema>;
export const ForgeMarkViewSchema = v.strictObject({
  principalId: PrincipalIdSchema,
  file: ForgeFileKeySchema,
  version: ObjectVersionSchema,
  result: ForgeReadResultSchema,
});

export const ForgeWatchSchema = v.strictObject({
  threadId: ThreadIdSchema,
  pull: ForgePullSchema,
  generation: CommandIdSchema,
});
export type ForgeWatch = v.InferOutput<typeof ForgeWatchSchema>;
export const ForgeHistorySourceSchema = v.picklist(["checks", "timeline", "discussion"]);
export type ForgeHistorySource = v.InferOutput<typeof ForgeHistorySourceSchema>;
const identity = { id: name, version: name, at: instant };
export const ForgeHistoryEventSchema = v.variant("kind", [
  v.strictObject({
    ...identity,
    kind: v.literal("check"),
    head: GitObjectIdSchema,
    result: v.picklist(["failed", "passed", "pending", "other"]),
  }),
  v.strictObject({ ...identity, kind: v.literal("review"), state: name }),
  v.strictObject({
    ...identity,
    kind: v.literal("pullRequest"),
    state: v.picklist(["open", "closed", "merged"]),
  }),
  v.strictObject({ ...identity, kind: v.literal("comment"), author: name }),
]);
export type ForgeHistoryEvent = v.InferOutput<typeof ForgeHistoryEventSchema>;
const coverage = v.variant("kind", [
  v.strictObject({ kind: v.literal("complete") }),
  v.strictObject({ kind: v.literal("gap"), reason: name }),
]);
export const ForgeHistorySchema = v.strictObject({
  watch: ForgeWatchSchema,
  source: ForgeHistorySourceSchema,
  from: instant,
  through: instant,
  events: v.array(ForgeHistoryEventSchema),
  coverage,
});
export type ForgeHistory = v.InferOutput<typeof ForgeHistorySchema>;
export const ThreadPullKeySchema = v.strictObject({
  threadId: ThreadIdSchema,
  pull: ForgePullSchema,
});
export const ThreadPullLinkSchema = v.strictObject({
  ...ThreadPullKeySchema.entries,
  projectId: ProjectIdSchema,
  url: v.pipe(v.string(), v.url()),
  ...pair,
  title: v.string(),
  repositoryName: name,
  lastState: v.picklist(["open", "closed", "merged", "unknown"]),
  checkedAt: v.nullable(instant),
  linkedAt: instant,
  origin: v.picklist(["created", "existing", "recovered", "explicit"]),
  commandId: CommandIdSchema,
  stackPosition: positive,
});
export type ThreadPullLink = v.InferOutput<typeof ThreadPullLinkSchema>;
export type ThreadPullKey = v.InferOutput<typeof ThreadPullKeySchema>;
export const forgeSchemas = {
  ThreadPullKey: ThreadPullKeySchema,
  ThreadPullLink: ThreadPullLinkSchema,
  ForgePullMatch: ForgePullMatchSchema,
  ForgeRepository: ForgeRepositorySchema,
  ForgeBranch: ForgeBranchSchema,
  ForgePublish: ForgePublishSchema,
  ForgeProgress: ForgeProgressSchema,
  ForgeProof: ForgeProofSchema,
  ForgePull: ForgePullSchema,
  ForgeFileKey: ForgeFileKeySchema,
  ForgeFileValue: ForgeFileValueSchema,
  ForgeReadMark: ForgeReadMarkSchema,
  ForgeReadResult: ForgeReadResultSchema,
  ForgeMarkView: ForgeMarkViewSchema,
  ForgeWatch: ForgeWatchSchema,
  ForgeHistoryEvent: ForgeHistoryEventSchema,
  ForgeHistory: ForgeHistorySchema,
};
