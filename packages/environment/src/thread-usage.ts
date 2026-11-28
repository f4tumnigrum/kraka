import * as v from "valibot";
import {
  UsageReadSchema,
  TokenCountersSchema,
  type Round,
  type ThreadId,
  type UsageBucket,
} from "@kraka/protocol";
import { matchesAdapterEvent, type AdapterEventEnvelope } from "./adapter-contract";
import type { ThreadSessionBinding } from "./executor-records";
import type { FirstSendStore } from "./first-send-store";
import { settingsSnapshot } from "./setting-store";
import { readSetting } from "./settings";

export function recordUsageEvent(
  store: FirstSendStore,
  binding: ThreadSessionBinding,
  round: Round,
  model: string,
  event: AdapterEventEnvelope,
  at: number,
) {
  const p = event.payload;
  if (
    p.kind !== "usageUpdated" ||
    !matchesAdapterEvent(binding, event) ||
    !binding.nativeSessionId ||
    round.threadId !== binding.threadId ||
    p.attemptId !== round.attempt.attemptId ||
    p.attemptId !== binding.attemptId ||
    !p.sourceId
  )
    return false;
  const scope: UsageBucket["scope"] =
    p.scope === "session"
      ? { kind: "session" }
      : p.scope === "round"
        ? { kind: "round", roundId: round.id }
        : { kind: "step", roundId: round.id, stepId: p.sourceId };
  const normalized = Object.fromEntries(
    Object.keys(TokenCountersSchema.entries).map((k) => [k, p.counters[k] ?? null]),
  );
  store.services.accountUsage.recordUsage({
    instanceId: binding.instanceId,
    threadId: binding.threadId,
    nativeSessionId: binding.nativeSessionId,
    sourceId: p.sourceId,
    scope,
    model,
    observedAt: at,
    counters: v.parse(TokenCountersSchema, normalized),
    amount: p.cost,
    currency: p.currency,
    priceSource: p.priceSource === "estimated" ? "providerEstimated" : p.priceSource,
  });
  return true;
}
export function readThreadUsage(store: FirstSendStore, threadId: ThreadId) {
  return store.db.transaction(() => {
    const query = {
      field: "modelRates",
      target: { kind: "environment", environmentId: store.writer.environmentId },
      checkout: null,
    } as const;
    const snapshot = settingsSnapshot(store, query);
    const row = snapshot && readSetting(snapshot, query);
    const rate =
      row?.field === "modelRates" && row.effective.sourceVersion !== null
        ? { models: row.effective.value.models, version: row.effective.sourceVersion }
        : null;
    const failures = store.db
      .query<{ round: string; resetAt: number | null }, [string]>(
        `SELECT round,json_extract(data,'$.quota.resetAt') AS resetAt FROM list_attempts
       WHERE source=? AND terminal=1 AND json_type(data,'$.quota')='object' ORDER BY rowid`,
      )
      .all(threadId);
    return v.parse(UsageReadSchema, {
      kind: "threadUsage",
      threadId,
      buckets: store.services.accountUsage.buckets(threadId, rate),
      limits: failures.map((row) => ({
        roundId: row.round,
        resetAt: row.resetAt,
        failure: "usageLimit",
        autoResume: false,
        recovery: "waitingForManualRetry",
      })),
    });
  })();
}
