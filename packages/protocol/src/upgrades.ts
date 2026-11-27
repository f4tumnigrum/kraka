import * as v from "valibot";
import { CommandIdSchema } from "./ids";

/** A version is a single release-directory name. The active pointer selects that directory atomically. */
export const ReleaseVersionSchema = v.pipe(v.string(), v.regex(/^[0-9A-Za-z][0-9A-Za-z._+-]*$/));
export const UpgradeRequestSchema = v.strictObject({ targetVersion: ReleaseVersionSchema });
export type UpgradeRequest = v.InferOutput<typeof UpgradeRequestSchema>;

const desktop = { owner: v.literal("desktop"), onDesktopQuit: v.literal("stop") };
const platform = v.picklist(["macos", "windows", "linux"]);
/** These rules describe the environment host. Closing a remote client never stops a remote service. */
export const EnvironmentDescriptionSchema = v.union([
  v.strictObject({
    ...desktop,
    platform: v.literal("macos"),
    onLastWindow: v.literal("keepRunning"),
  }),
  v.strictObject({
    ...desktop,
    platform: v.picklist(["windows", "linux"]),
    onLastWindow: v.literal("stop"),
  }),
  v.strictObject({
    owner: v.picklist(["service", "foreground"]),
    platform,
    onLastWindow: v.literal("keepRunning"),
    onDesktopQuit: v.literal("keepRunning"),
  }),
]);
export type EnvironmentDescription = v.InferOutput<typeof EnvironmentDescriptionSchema>;
const activeVersion = ReleaseVersionSchema;
const change = {
  activeVersion,
  commandId: CommandIdSchema,
  previousVersion: ReleaseVersionSchema,
  targetVersion: ReleaseVersionSchema,
};
export const UpgradeViewSchema = v.variant("phase", [
  v.strictObject({ phase: v.literal("idle"), activeVersion }),
  v.strictObject({
    phase: v.picklist(["staged", "verified", "migrating", "committed"]),
    ...change,
  }),
  v.strictObject({
    phase: v.picklist(["rollingBack", "rolledBack"]),
    ...change,
    reason: v.pipe(v.string(), v.minLength(1)),
  }),
]);
export type UpgradeView = v.InferOutput<typeof UpgradeViewSchema>;
