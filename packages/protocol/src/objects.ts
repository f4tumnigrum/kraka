import * as v from "valibot";
import { CheckpointResultSchema } from "./checkpoints";
import { HistoryCoverageSchema } from "./handoffs";
import {
  AttachmentIdSchema,
  AttemptIdSchema,
  CaptureIdSchema,
  CommandIdSchema,
  EnvironmentIdSchema,
  ExecutorInstanceIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  ProjectIdSchema,
  QueuePositionSchema,
  RoundIdSchema,
  ThreadIdSchema,
  TodoRequestIdSchema,
  TimelineItemIdSchema,
  WorktreeIdSchema,
} from "./ids";
import { RoundAttemptSchema, TodoStateSchema } from "./lifecycle";
import { SecretPurposeSchema } from "./private-secrets";
import { ThreadLifecycleSchema } from "./thread-list";
import { DirectoryBindingSchema, ProjectRootSchema } from "./workspace";

export const EnvironmentSchema = v.strictObject({
  id: EnvironmentIdSchema,
  version: ObjectVersionSchema,
});

export const ProjectSchema = v.strictObject({
  root: v.optional(ProjectRootSchema),
  id: ProjectIdSchema,
  environmentId: EnvironmentIdSchema,
  version: ObjectVersionSchema,
});

export const WorktreeSchema = v.strictObject({
  id: WorktreeIdSchema,
  projectId: ProjectIdSchema,
  version: ObjectVersionSchema,
});

const rootLineageSchema = v.strictObject({ kind: v.literal("root") });
const childLineageFields = { kind: v.literal("child"), parentThreadId: ThreadIdSchema };
const childLineageSchema = v.strictObject(childLineageFields);
const forkLineageFields = {
  kind: v.literal("fork"),
  parentThreadId: ThreadIdSchema,
  sourceRoundId: RoundIdSchema,
  sideChat: v.boolean(),
};
const forkLineageSchema = v.strictObject(forkLineageFields);

export const ThreadLineageSchema = v.variant("kind", [
  rootLineageSchema,
  childLineageSchema,
  forkLineageSchema,
]);

export const ThreadSchema = v.strictObject({
  lifecycle: v.optional(ThreadLifecycleSchema),
  directory: v.optional(DirectoryBindingSchema),
  id: ThreadIdSchema,
  projectId: ProjectIdSchema,
  worktreeId: v.nullable(WorktreeIdSchema),
  title: v.string(),
  lineage: ThreadLineageSchema,
  version: ObjectVersionSchema,
});

export const ThreadReferenceSchema = v.strictObject({
  kind: v.literal("thread"),
  threadId: ThreadIdSchema,
});

export const MessageReferenceSchema = v.variant("kind", [
  ThreadReferenceSchema,
  v.strictObject({
    kind: v.literal("mention"),
    path: v.string(),
    availability: v.picklist(["available", "unavailable"]),
  }),
]);

export const AttachmentReferenceSchema = v.strictObject({
  kind: v.picklist(["text", "image", "file"]),
  id: AttachmentIdSchema,
  version: ObjectVersionSchema,
});

export const SubjectSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("person"), id: PrincipalIdSchema }),
  v.strictObject({ kind: v.literal("executor"), id: ExecutorInstanceIdSchema }),
]);

export const MessageSchema = v.strictObject({
  id: MessageIdSchema,
  threadId: ThreadIdSchema,
  roundId: v.nullable(RoundIdSchema),
  author: SubjectSchema,
  text: v.string(),
  references: v.array(MessageReferenceSchema),
  attachments: v.array(AttachmentReferenceSchema),
  version: ObjectVersionSchema,
});

export const RoundSchema = v.strictObject({
  id: RoundIdSchema,
  threadId: ThreadIdSchema,
  messageId: MessageIdSchema,
  place: QueuePositionSchema,
  attempt: RoundAttemptSchema,
  attempts: v.optional(
    v.array(
      v.strictObject({
        ...RoundAttemptSchema.entries,
        origin: v.variant("kind", [
          v.strictObject({ kind: v.literal("initial") }),
          v.strictObject({
            kind: v.literal("userResend"),
            commandId: CommandIdSchema,
            target: AttemptIdSchema,
          }),
          v.strictObject({ kind: v.literal("automaticContinuation") }),
        ]),
      }),
    ),
  ),
  steering: v.optional(
    v.array(
      v.strictObject({
        attemptId: AttemptIdSchema,
        messageId: MessageIdSchema,
        state: v.picklist(["pending", "completed"]),
      }),
    ),
  ),
  version: ObjectVersionSchema,
});

export const CheckpointCaptureSchema = v.strictObject({
  id: CaptureIdSchema,
  roundId: RoundIdSchema,
  attemptId: AttemptIdSchema,
  result: CheckpointResultSchema,
  version: ObjectVersionSchema,
});

const question = v.strictObject({
  key: v.string(),
  text: v.pipe(v.string(), v.minLength(1)),
  choices: v.array(v.string()),
});
export const TodoRequestBodySchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("approval"),
    tool: v.picklist(["command", "file", "other"]),
    choices: v.array(
      v.strictObject({
        key: v.string(),
        scope: v.picklist(["once", "session", "project", "persistent", "unknown"]),
        allowsEdit: v.boolean(),
      }),
    ),
  }),
  v.strictObject({
    kind: v.literal("question"),
    questions: v.tupleWithRest([question], question),
  }),
  v.strictObject({
    kind: v.literal("secret"),
    slot: v.string(),
    purpose: v.optional(SecretPurposeSchema),
  }),
]);

export const TodoRequestSchema = v.strictObject({
  id: TodoRequestIdSchema,
  threadId: ThreadIdSchema,
  roundId: RoundIdSchema,
  body: TodoRequestBodySchema,
  state: TodoStateSchema,
  version: ObjectVersionSchema,
});

export const WorkRelationshipSchema = v.variant("kind", [
  v.strictObject({ ...childLineageFields, targetThreadId: ThreadIdSchema }),
  v.strictObject({ ...forkLineageFields, targetThreadId: ThreadIdSchema }),
  v.strictObject({
    kind: v.literal("providerHandoff"),
    threadId: ThreadIdSchema,
    sourceSessionId: NativeSessionIdSchema,
    targetSessionId: v.nullable(NativeSessionIdSchema),
    messageIds: v.array(MessageIdSchema),
    /** Missing coverage on an older relationship remains unknown. */
    history: v.optional(HistoryCoverageSchema),
  }),
]);

export type Environment = v.InferOutput<typeof EnvironmentSchema>;
export type Project = v.InferOutput<typeof ProjectSchema>;
export type Worktree = v.InferOutput<typeof WorktreeSchema>;
export type ThreadLineage = v.InferOutput<typeof ThreadLineageSchema>;
export type Thread = v.InferOutput<typeof ThreadSchema>;
export type ThreadReference = v.InferOutput<typeof ThreadReferenceSchema>;
export type AttachmentReference = v.InferOutput<typeof AttachmentReferenceSchema>;
export type MessageReference = v.InferOutput<typeof MessageReferenceSchema>;
export type Subject = v.InferOutput<typeof SubjectSchema>;
export type Message = v.InferOutput<typeof MessageSchema>;
export type Round = v.InferOutput<typeof RoundSchema>;
/** Minor 1 adds attempt history and steering to thread and history reads. */
export function roundForProtocol(round: Round, minor: number): Round {
  if (minor >= 1) return round;
  const { attempts, steering, ...legacy } = round;
  return legacy;
}

export type CheckpointCapture = v.InferOutput<typeof CheckpointCaptureSchema>;
export type TodoRequestBody = v.InferOutput<typeof TodoRequestBodySchema>;
export type TodoRequest = v.InferOutput<typeof TodoRequestSchema>;
export type WorkRelationship = v.InferOutput<typeof WorkRelationshipSchema>;
export type ExecutorHandoff = Extract<WorkRelationship, { kind: "providerHandoff" }>;

export const ObjectKeySchema = v.variant("objectType", [
  v.strictObject({
    objectType: v.literal("timelineItem"),
    threadId: ThreadIdSchema,
    id: TimelineItemIdSchema,
  }),
  v.strictObject({ objectType: v.literal("environment"), id: EnvironmentIdSchema }),
  v.strictObject({ objectType: v.literal("project"), id: ProjectIdSchema }),
  v.strictObject({ objectType: v.literal("worktree"), id: WorktreeIdSchema }),
  v.strictObject({ objectType: v.literal("thread"), id: ThreadIdSchema }),
  v.strictObject({ objectType: v.literal("message"), id: MessageIdSchema }),
  v.strictObject({ objectType: v.literal("round"), id: RoundIdSchema }),
  v.strictObject({ objectType: v.literal("todoRequest"), id: TodoRequestIdSchema }),
  v.strictObject({ objectType: v.literal("checkpointCapture"), id: CaptureIdSchema }),
]);
