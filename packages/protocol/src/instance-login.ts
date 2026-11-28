import * as v from "valibot";
import { CommandIdSchema, ExecutorInstanceIdSchema } from "./ids";
const text = v.pipe(v.string(), v.minLength(1));
export const StartLoginSchema = v.strictObject({
  instanceId: ExecutorInstanceIdSchema,
  interaction: v.picklist(["browser", "deviceCode", "nativeCli"]),
  expectedAccount: text,
});
export const LoginTargetSchema = v.strictObject({
  instanceId: ExecutorInstanceIdSchema,
  flowId: CommandIdSchema,
});
export const LoginInteractionSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("browser"), url: text }),
  v.strictObject({ kind: v.literal("deviceCode"), url: text, userCode: text }),
  v.strictObject({ kind: v.literal("nativeCli"), instructions: text }),
]);
export const LoginPhaseSchema = v.picklist([
  "starting",
  "browser",
  "deviceCode",
  "nativeCli",
  "verifying",
  "authenticated",
  "failed",
  "cancelled",
  "expired",
]);
export const InstanceLoginResultSchema = v.strictObject({
  kind: v.literal("instanceLogin"),
  ...LoginTargetSchema.entries,
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  phase: LoginPhaseSchema,
  reason: v.nullable(text),
  interaction: v.nullable(LoginInteractionSchema),
});
export type LoginInteraction = v.InferOutput<typeof LoginInteractionSchema>;
export type InstanceLoginResult = v.InferOutput<typeof InstanceLoginResultSchema>;
