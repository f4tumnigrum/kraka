import * as v from "valibot";
import {
  ObjectVersionSchema,
  EnvironmentIdSchema,
  ProjectIdSchema,
  ThreadIdSchema,
  QueuePositionSchema,
  SyncCursorSchema,
} from "./ids";
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const order = {
  pinnedAt: v.nullable(count),
  pinPosition: v.nullable(QueuePositionSchema),
  manualPosition: v.nullable(QueuePositionSchema),
  snoozedUntil: v.nullable(count),
};
export const ThreadLifecycleSchema = v.strictObject({
  archivedAt: v.nullable(count),
  state: v.variant("kind", [
    v.strictObject({ kind: v.literal("active"), ...order }),
    v.strictObject({
      kind: v.literal("settled"),
      at: count,
      reason: v.picklist(["manual", "idle", "merged", "closed"]),
    }),
  ]),
});
export type ThreadLifecycle = v.InferOutput<typeof ThreadLifecycleSchema>;
export const ThreadChangeSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("pin"), position: v.nullable(QueuePositionSchema) }),
  v.strictObject({
    kind: v.picklist(["archive", "unarchive", "settle", "reopen", "unpin", "wake"]),
  }),
  v.strictObject({ kind: v.literal("snooze"), until: count }),
  v.strictObject({ kind: v.literal("order"), position: v.nullable(QueuePositionSchema) }),
]);
export const ThreadSummarySchema = v.strictObject({
  threadId: ThreadIdSchema,
  projectId: ProjectIdSchema,
  parentThreadId: v.nullable(ThreadIdSchema),
  version: ObjectVersionSchema,
  title: v.string(),
  createdAt: count,
  lastActivityAt: count,
  lifecycle: ThreadLifecycleSchema,
  openTodos: count,
  activeRounds: count,
});
export const ListCountsSchema = v.strictObject({
  active: count,
  pinned: count,
  snoozed: count,
  settled: count,
  archived: count,
});
const cursor = v.strictObject({
  snapshot: SyncCursorSchema,
  settledAt: count,
  threadId: ThreadIdSchema,
});
export const EarlierSettledRequestSchema = v.strictObject({
  target: v.variant("kind", [
    v.strictObject({ kind: v.literal("environment"), environmentId: EnvironmentIdSchema }),
    v.strictObject({ kind: v.literal("project"), projectId: ProjectIdSchema }),
  ]),
  after: v.nullable(cursor),
});
export const EarlierSettledPageSchema = v.strictObject({
  through: SyncCursorSchema,
  threads: v.pipe(
    v.array(
      v.strictObject({
        ...ThreadSummarySchema.entries,
        lifecycle: v.strictObject({
          archivedAt: v.null(),
          state: ThreadLifecycleSchema.entries.state.options[1],
        }),
      }),
    ),
    v.maxLength(25),
  ),
  counts: ListCountsSchema,
  next: v.nullable(cursor),
});
export type ThreadChange = v.InferOutput<typeof ThreadChangeSchema>;
export type ThreadSummary = v.InferOutput<typeof ThreadSummarySchema>;
