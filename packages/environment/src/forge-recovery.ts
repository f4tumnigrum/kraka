import * as v from "valibot";
import {
  AttemptIdSchema,
  CommandIdSchema,
  ForgeRepositorySchema,
  type ForgeProgress,
} from "@kraka/protocol";

const instant = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const account = {
  host: ForgeRepositorySchema.entries.host,
  accountId: v.pipe(v.string(), v.minLength(1)),
};
export const ForgeRateLimitSchema = v.strictObject({ ...account, until: instant });
export const PullVerificationScheduleSchema = v.strictObject({
  commandId: CommandIdSchema,
  attemptId: AttemptIdSchema,
  ...account,
  nextCheckAt: instant,
  paused: v.nullable(v.picklist(["offline", "credentialInvalid", "authorizationRevoked"])),
});
export type PullVerificationSchedule = v.InferOutput<typeof PullVerificationScheduleSchema>;
export const FORGE_RECHECK_INTERVAL_MS = 120_000;
/** The caller merges concurrent reads by command and attempt. Commit the new deadline before issuing the one read. */
export function planPullVerification(
  progress: ForgeProgress,
  schedule: PullVerificationSchedule,
  limit: v.InferOutput<typeof ForgeRateLimitSchema> | null,
  now: number,
):
  | { kind: "retired" | "paused" }
  | { kind: "wait"; until: number }
  | { kind: "read"; reservation: PullVerificationSchedule } {
  const step = progress.steps.pullRequest;
  if (
    step.kind !== "verify" ||
    progress.commandId !== schedule.commandId ||
    step.attemptId !== schedule.attemptId ||
    progress.request.source.repository.host !== schedule.host
  )
    return { kind: "retired" };
  if (schedule.paused !== null) return { kind: "paused" };
  const until =
    limit?.host === schedule.host && limit.accountId === schedule.accountId
      ? Math.max(schedule.nextCheckAt, limit.until)
      : schedule.nextCheckAt;
  return now < until
    ? { kind: "wait", until }
    : { kind: "read", reservation: { ...schedule, nextCheckAt: now + FORGE_RECHECK_INTERVAL_MS } };
}
