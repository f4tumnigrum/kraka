import * as v from "valibot";
import { TimelineItemIdSchema, type ThreadId, type ToolActivityHistoryItem } from "@kraka/protocol";
import type { ToolActivityView } from "../../packages/client-runtime/src";
import type { connectReplica } from "./thread-resume";
import { Journal } from "./route-network";
import { within } from "./replay-process";

export type ActivityClient = Awaited<ReturnType<typeof connectReplica>>;
export function toolFact(
  threadId: ThreadId,
  phase: ToolActivityHistoryItem["phase"],
  outputText: string | null = null,
  exitCode: number | null = null,
) {
  return {
    threadId,
    instanceId: "codex-test",
    nativeSessionId: "session",
    epoch: 1,
    eventId: phase,
    callId: "failed-call",
    attemptId: "attempt-1",
    nativeRootTurnId: "root-1",
    phase,
    inputJson: phase === "started" ? JSON.stringify({ command: "check changes" }) : null,
    outputText,
    exitCode,
    at: 1000,
  };
}
export function installedTool(c: ActivityClient) {
  for (const entry of Object.values(c.cache.read().rows)) {
    if (entry.row?.objectType === "timelineItem" && entry.row.value.kind === "toolActivity")
      return entry.row.value;
  }
  throw Error("No installed tool summary");
}
export async function expand(
  c: ActivityClient,
  item: Pick<ToolActivityHistoryItem, "threadId" | "id">,
  expectedVersion: ToolActivityHistoryItem["version"] | null = null,
) {
  const versions = new Journal<ToolActivityView>(),
    errors = Promise.withResolvers<never>();
  void errors.promise.catch(() => {});
  const viewer = await c.client.readActivity({
    threadId: item.threadId,
    itemId: v.parse(TimelineItemIdSchema, item.id),
    expectedVersion,
    onVersion: (v) => versions.push(v),
    onError: (e) => errors.reject(e),
  });
  if (viewer.kind !== "opened") throw Error("Expected a detail subscription: " + viewer.kind);
  return {
    viewer,
    versions,
    at: (v: string) =>
      within(
        Promise.race([versions.until((x) => x.item.version === v), errors.promise]),
        15000,
        "tool body " + v,
      ),
  };
}
