import * as v from "valibot";
import { PermissionModeSchema } from "./access";
import {
  AttemptIdSchema,
  CommandIdSchema,
  NativeItemIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  RoundIdSchema,
} from "./ids";
import { InputContentSchema } from "./requests";

export const ReplayRunRequestSchema = v.strictObject({
  kind: v.literal("replay.run"),
  commandId: CommandIdSchema,
  permission: PermissionModeSchema,
  input: InputContentSchema,
});
export type ReplayRunRequest = v.InferOutput<typeof ReplayRunRequestSchema>;

const turn = { roundId: RoundIdSchema, attemptId: AttemptIdSchema };
const tool = { ...turn, callId: NativeItemIdSchema };
const assistant = { ...turn, itemId: NativeItemIdSchema, role: v.literal("assistant") };
const text = v.pipe(v.string(), v.minLength(1));
const time = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const ReplayTurnUpdateSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("round.started"),
    ...turn,
    nativeSessionId: NativeSessionIdSchema,
    nativeRootTurnId: NativeRootTurnIdSchema,
    startedAt: time,
    phase: v.literal("working"),
    selectedMode: v.literal("ask"),
    effectiveMode: v.literal("ask"),
    supportedModes: v.strictTuple([v.literal("ask")]),
    enforcement: v.literal("adapter"),
  }),
  v.strictObject({ kind: v.literal("tool.started"), ...tool, command: text }),
  v.strictObject({ kind: v.literal("tool.output"), ...tool, text }),
  v.strictObject({
    kind: v.literal("tool.ended"),
    ...tool,
    exitCode: v.pipe(v.number(), v.integer()),
    output: text,
  }),
  v.strictObject({
    kind: v.literal("assistant.delta"),
    ...assistant,
    streaming: v.literal(true),
    text,
  }),
  v.strictObject({
    kind: v.literal("assistant.final"),
    ...assistant,
    streaming: v.literal(false),
    text,
  }),
  v.strictObject({
    kind: v.literal("round.ended"),
    ...turn,
    nativeRootTurnId: NativeRootTurnIdSchema,
    endedAt: time,
    outcome: v.literal("completed"),
    phase: v.literal("closing"),
  }),
]);
export type ReplayTurnUpdate = v.InferOutput<typeof ReplayTurnUpdateSchema>;
