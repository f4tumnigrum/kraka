import * as v from "valibot";
import {
  AttemptIdSchema,
  SyncCursorSchema,
  EnvironmentIdSchema,
  DeviceIdSchema,
  PrincipalIdSchema,
  RoundIdSchema,
  SyncPositionSchema,
  ThreadIdSchema,
  TodoRequestIdSchema,
} from "./ids";
import { RoundPhaseSchema, RoundAttemptSchema } from "./lifecycle";
import { RoundSchema, TodoRequestSchema } from "./objects";

const scope = {
  ownerId: PrincipalIdSchema,
  environmentId: EnvironmentIdSchema,
  databaseGeneration: v.pipe(v.string(), v.minLength(1)),
};
export const AttentionThreadSchema = v.strictObject({ ...scope, threadId: ThreadIdSchema });
export type AttentionThread = v.InferOutput<typeof AttentionThreadSchema>;
const requestAddress = v.strictObject({
  kind: v.literal("request"),
  requestId: TodoRequestIdSchema,
});
const roundAddress = v.strictObject({
  kind: v.literal("round"),
  roundId: RoundIdSchema,
  attemptId: AttemptIdSchema,
});
export const AttentionObjectSchema = v.variant("kind", [requestAddress, roundAddress]);
export const ReminderKeySchema = v.strictObject({
  ...AttentionThreadSchema.entries,
  object: AttentionObjectSchema,
});
export type ReminderKey = v.InferOutput<typeof ReminderKeySchema>;

/** Persisted only on the device, outside the replaceable subscription cache. */
export const ReminderRecordSchema = v.strictObject({
  deviceId: DeviceIdSchema,
  key: ReminderKeySchema,
  state: v.picklist(["claimed", "posted", "suppressed", "unconfirmed", "withdrawn"]),
});
export type ReminderRecord = v.InferOutput<typeof ReminderRecordSchema>;

/** An address-only hint can be followed only after a fresh authorization check on the source. */
export const AttentionHintSchema = v.union([
  v.strictObject({
    kind: v.picklist(["approval", "question", "secret"]),
    key: v.strictObject({ ...AttentionThreadSchema.entries, object: requestAddress }),
  }),
  v.strictObject({
    kind: v.picklist(["roundFailed", "roundCompleted"]),
    key: v.strictObject({ ...AttentionThreadSchema.entries, object: roundAddress }),
  }),
]);
export type AttentionHint = v.InferOutput<typeof AttentionHintSchema>;

const requestFact = v.strictObject({
  answerable: v.optional(v.boolean()),
  request: v.pick(TodoRequestSchema, ["id", "body", "state"]),
  openedAt: SyncPositionSchema,
});
const roundFact = v.strictObject({
  round: v.pick(RoundSchema, ["id", "attempt"]),
  changedAt: v.pipe(
    SyncPositionSchema,
    v.description(
      "Occurrence position. For a terminal attempt this is the original end position, including after later receipt or capture updates.",
    ),
  ),
  quota: v.nullable(
    v.strictObject({ resetAt: v.nullable(v.pipe(v.number(), v.safeInteger(), v.minValue(0))) }),
  ),
  review: v.nullable(
    v.strictObject({ kind: v.picklist(["plan", "work"]), deferredAtEnd: v.boolean() }),
  ),
});
const sourceFacts = v.strictObject({
  threadId: ThreadIdSchema,
  readThrough: v.nullable(SyncPositionSchema),
  grouping: v.picklist(["ordinary", "settled", "archived"]),
  requests: v.array(requestFact),
  rounds: v.array(roundFact),
});

/** One authorized read point contains the root and all visible descendants. Positions refer to occurrence, not row refresh. */
export const AttentionFactsSchema = v.strictObject({
  ...scope,
  through: SyncPositionSchema,
  root: sourceFacts,
  descendants: v.array(sourceFacts),
});
export type AttentionFacts = v.InferOutput<typeof AttentionFactsSchema>;
/** A retained occurrence is the original request creation or the end of one particular attempt. */
export const AttentionOccurrenceSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("requestOpened"),
    threadId: ThreadIdSchema,
    ...requestFact.entries,
  }),
  v.strictObject({
    kind: v.literal("roundEnded"),
    threadId: ThreadIdSchema,
    ...roundFact.entries,
    round: v.strictObject({
      id: RoundIdSchema,
      attempt: v.strictObject({
        ...RoundAttemptSchema.entries,
        phase: v.variant(
          "kind",
          RoundPhaseSchema.options.filter(
            (p) => p.entries.kind.literal === "finished" || p.entries.kind.literal === "endedEarly",
          ),
        ),
      }),
    }),
    readThrough: v.nullable(SyncPositionSchema),
    grouping: sourceFacts.entries.grouping,
  }),
]);
export type AttentionOccurrence = v.InferOutput<typeof AttentionOccurrenceSchema>;
const occurrenceCursor = v.strictObject({
  position: SyncPositionSchema,
  threadId: ThreadIdSchema,
  object: AttentionObjectSchema,
});
export const AttentionReadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  selection: v.variant("kind", [
    v.strictObject({ kind: v.literal("current") }),
    v.strictObject({
      kind: v.literal("object"),
      databaseGeneration: scope.databaseGeneration,
      object: AttentionObjectSchema,
    }),
    v.strictObject({
      kind: v.literal("since"),
      installed: SyncCursorSchema,
      through: SyncCursorSchema,
      after: v.nullable(occurrenceCursor),
    }),
  ]),
});
export const AttentionHistoryResultSchema = v.strictObject({
  kind: v.literal("attentionHistory"),
  ownerId: PrincipalIdSchema,
  through: SyncCursorSchema,
  occurrences: v.array(AttentionOccurrenceSchema),
  next: v.nullable(occurrenceCursor),
});
export const AttentionObjectResultSchema = v.strictObject({
  kind: v.literal("attentionObject"),
  ...scope,
  occurrence: AttentionOccurrenceSchema,
});
export const attentionSchemas = {
  AttentionThread: AttentionThreadSchema,
  AttentionRead: AttentionReadSchema,
  AttentionOccurrence: AttentionOccurrenceSchema,
  AttentionHistory: AttentionHistoryResultSchema,
  AttentionObject: AttentionObjectResultSchema,
  ReminderKey: ReminderKeySchema,
  ReminderRecord: ReminderRecordSchema,
  AttentionHint: AttentionHintSchema,
  AttentionFacts: AttentionFactsSchema,
};
