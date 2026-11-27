import * as v from "valibot";
import {
  CommandIdSchema,
  EnvironmentSessionIdSchema,
  ContentTransferIdSchema,
  SubscriptionIdSchema,
  TerminalGenerationSchema,
  TerminalIdSchema,
  TerminalOffsetSchema,
  ThreadIdSchema,
} from "./ids";

const axis = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(4096));
export const TerminalGridSchema = v.strictObject({ cols: axis, rows: axis });
export type TerminalGrid = v.InferOutput<typeof TerminalGridSchema>;
export const ProcessIdentitySchema = v.strictObject({
  pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  startedAt: v.pipe(
    v.number(),
    v.safeInteger(),
    v.minValue(0),
    v.description("Operating system process start time in Unix milliseconds."),
  ),
});
export type ProcessIdentity = v.InferOutput<typeof ProcessIdentitySchema>;
export const TerminalAddressSchema = v.strictObject({
  threadId: ThreadIdSchema,
  terminalId: TerminalIdSchema,
  generation: TerminalGenerationSchema,
});
export type TerminalAddress = v.InferOutput<typeof TerminalAddressSchema>;
const identity = TerminalAddressSchema.entries;
const previous = v.strictObject({
  generation: TerminalGenerationSchema,
  head: TerminalOffsetSchema,
  process: v.nullable(ProcessIdentitySchema),
  reason: v.literal("environmentRestart"),
});
const session = { ...identity, previous: v.nullable(previous), head: TerminalOffsetSchema };
export const TerminalSessionSchema = v.variant("kind", [
  v.strictObject({ ...session, kind: v.literal("starting"), grid: TerminalGridSchema }),
  v.strictObject({
    ...session,
    kind: v.literal("running"),
    process: ProcessIdentitySchema,
    grid: TerminalGridSchema,
  }),
  v.strictObject({
    ...session,
    kind: v.literal("exited"),
    process: v.nullable(ProcessIdentitySchema),
    reason: v.picklist(["shellExit", "closed", "environmentStopped"]),
    code: v.nullable(v.pipe(v.number(), v.safeInteger())),
    signal: v.nullable(v.string()),
  }),
  v.strictObject({
    ...session,
    kind: v.literal("lost"),
    process: v.nullable(ProcessIdentitySchema),
    reason: v.literal("environmentRestart"),
  }),
]);
export type TerminalSession = v.InferOutput<typeof TerminalSessionSchema>;
const streamId = v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2147483647));
const viewer = { ...identity, subscriptionId: SubscriptionIdSchema };
const content = v.nullable(ContentTransferIdSchema);
export const TerminalSnapshotSchema = v.strictObject({
  kind: v.literal("terminal.snapshot"),
  ...viewer,
  retainedFrom: TerminalOffsetSchema,
  from: TerminalOffsetSchema,
  head: TerminalOffsetSchema,
  content,
});
export const TerminalOutputSchema = v.strictObject({
  kind: v.literal("terminal.output"),
  ...viewer,
  from: TerminalOffsetSchema,
  to: TerminalOffsetSchema,
  content: ContentTransferIdSchema,
});
export const TerminalGapSchema = v.strictObject({
  kind: v.literal("terminal.gap"),
  ...viewer,
  from: TerminalOffsetSchema,
  to: TerminalOffsetSchema,
  missingBytes: TerminalOffsetSchema,
  head: TerminalOffsetSchema,
});
export type TerminalSnapshot = v.InferOutput<typeof TerminalSnapshotSchema>;
export type TerminalOutput = v.InferOutput<typeof TerminalOutputSchema>;
export type TerminalGap = v.InferOutput<typeof TerminalGapSchema>;

export const TerminalOpenSchema = v.strictObject({
  threadId: ThreadIdSchema,
  grid: TerminalGridSchema,
});
export const TerminalAttachSchema = v.strictObject({
  ...viewer,
  after: TerminalOffsetSchema,
  grid: TerminalGridSchema,
  streamId,
});
export const TerminalResizeSchema = v.strictObject({ ...viewer, grid: TerminalGridSchema });
export const TerminalDetachSchema = v.strictObject(viewer);
export const TerminalAckSchema = v.strictObject({ ...viewer, through: TerminalOffsetSchema });
export const TerminalControlRequestSchema = v.strictObject(viewer);
/** The control grant belongs to the authenticated connection and viewer. Changing shell generation invalidates it. */
export const TerminalControlSchema = v.strictObject({
  ...viewer,
  environmentSessionId: EnvironmentSessionIdSchema,
  lease: CommandIdSchema,
});
export type TerminalControl = v.InferOutput<typeof TerminalControlSchema>;
export const TerminalWriteSchema = v.strictObject({
  ...viewer,
  lease: CommandIdSchema,
  bytes: v.pipe(
    v.string(),
    v.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    v.minLength(4),
    v.description(
      "Raw input bytes encoded as padded base64. The signed command ID identifies this write.",
    ),
  ),
});
export const TerminalInputReceiptSchema = v.strictObject({
  ...identity,
  commandId: CommandIdSchema,
  outcome: v.picklist(["accepted", "confirmed", "unknown"]),
});
export const terminalSchemas = {
  TerminalId: TerminalIdSchema,
  TerminalGeneration: TerminalGenerationSchema,
  TerminalOffset: TerminalOffsetSchema,
  TerminalAddress: TerminalAddressSchema,
  TerminalGrid: TerminalGridSchema,
  TerminalControl: TerminalControlSchema,
  ProcessIdentity: ProcessIdentitySchema,
  TerminalSession: TerminalSessionSchema,
  TerminalSnapshot: TerminalSnapshotSchema,
  TerminalOutput: TerminalOutputSchema,
  TerminalGap: TerminalGapSchema,
  TerminalInputReceipt: TerminalInputReceiptSchema,
};
