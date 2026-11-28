import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  AccountQuotaSnapshotSchema,
  UsageBucketSchema,
  canonicalJson,
  type AccountQuotaSnapshot,
  type QuotaWindow,
  type UsageBucket,
  type ModelRates,
  type ObjectVersion,
  type ThreadId,
} from "@kraka/protocol";

export const accountUsageTables = `
CREATE TABLE IF NOT EXISTS quota_sources(instance TEXT PRIMARY KEY, binding TEXT NOT NULL, refresh INTEGER NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS quota_schedule(singleton INTEGER PRIMARY KEY CHECK(singleton=1), attempted INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_records(thread TEXT NOT NULL, instance TEXT NOT NULL, session TEXT NOT NULL, scope TEXT NOT NULL, source TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(thread,instance,session,scope,source));
`;
export type QuotaSource = AccountQuotaSnapshot["source"];
type Outcome = NonNullable<AccountQuotaSnapshot["outcome"]>;
export type AccountBinding = {
  source: QuotaSource;
  registrationVersion: ObjectVersion;
  credentialKey: string | null;
};
type Ticket = { source: AccountBinding; refreshId: number; revision: number };
export type QuotaObservation = Ticket & {
  mode: "full" | "partial";
  observedAt: number;
  attemptedAt: number;
  windows: readonly QuotaWindow[];
  outcome: Outcome;
};
function empty(source: QuotaSource): AccountQuotaSnapshot {
  return {
    source,
    version: 0,
    windows: [],
    lastSuccessAt: null,
    lastAttemptAt: null,
    outcome: null,
    state: { kind: "neverObserved" },
  };
}
function atTime(snapshot: AccountQuotaSnapshot, now: number): AccountQuotaSnapshot {
  const windows = snapshot.windows.map((w) => ({
    ...w,
    stale: snapshot.state.kind === "stale" || (w.resetAt !== null && now >= w.resetAt),
  }));
  return {
    ...snapshot,
    windows,
    state:
      snapshot.state.kind === "fresh" && windows.some((w) => w.stale)
        ? { kind: "stale", reason: "resetReached" }
        : snapshot.state,
  };
}
export type PriceTable = { models: ModelRates["models"]; version: ObjectVersion };
type Fact = Omit<UsageBucket, "unpricedRecords" | "priceVersion" | "priceSource"> & {
  priceSource: "reported" | "providerEstimated" | "unknown";
};
function estimate(
  fact: Fact,
  table: PriceTable | null,
  priceSource: "custom" | "catalog",
): UsageBucket | null {
  const price = table && Object.hasOwn(table.models, fact.model) && table.models[fact.model];
  if (!price || !table) return null;
  let micros = 0;
  for (const key of ["uncachedInput", "cacheRead", "cacheWrite", "output"] as const) {
    const n = fact.counters[key],
      rate = price[key];
    if (n === 0) continue;
    if (n === null || rate === undefined) return null;
    micros += n * rate;
  }
  if (!Number.isFinite(micros)) return null;
  return {
    ...fact,
    amount: micros / 1_000_000,
    currency: price.currency,
    priceSource,
    priceVersion: table.version,
    unpricedRecords: 0,
  };
}
function priceBucket(
  fact: Fact,
  custom: PriceTable | null,
  catalog: PriceTable | null,
): UsageBucket {
  const chosen = estimate(fact, custom, "custom");
  if (chosen) return chosen;
  if (fact.priceSource !== "unknown" && fact.amount !== null && fact.currency)
    return { ...fact, priceVersion: null, unpricedRecords: 0 };
  return (
    estimate(fact, catalog, "catalog") ?? {
      ...fact,
      amount: null,
      currency: null,
      priceVersion: null,
      priceSource: "unknown",
      unpricedRecords: 1,
    }
  );
}
const factSchema = v.strictObject({
  ...UsageBucketSchema.entries,
  priceSource: v.picklist(["reported", "providerEstimated", "unknown"]),
});
export class AccountUsageStore {
  constructor(private db: Database) {}
  private row(instance: string) {
    return this.db
      .query<{ binding: string; refresh: number; data: string }, [string]>(
        "SELECT binding,refresh,data FROM quota_sources WHERE instance=?",
      )
      .get(instance);
  }
  bind(binding: AccountBinding) {
    const id = binding.source.instanceId,
      key = canonicalJson(binding);
    this.db.run(
      `INSERT INTO quota_sources VALUES(?,?,0,?) ON CONFLICT(instance) DO UPDATE SET binding=excluded.binding, refresh=0,data=excluded.data WHERE quota_sources.binding<>excluded.binding`,
      [id, key, JSON.stringify(empty(binding.source))],
    );
  }
  read(binding: AccountBinding, now: number) {
    const row = this.row(binding.source.instanceId);
    return atTime(
      row?.binding === canonicalJson(binding)
        ? v.parse(AccountQuotaSnapshotSchema, JSON.parse(row.data))
        : empty(binding.source),
      now,
    );
  }
  begin(binding: AccountBinding, attemptedAt: number): Ticket {
    return this.db.transaction(() => {
      const row = this.row(binding.source.instanceId);
      if (!row || row.binding !== canonicalJson(binding)) throw Error("Quota binding changed");
      const snapshot = v.parse(AccountQuotaSnapshotSchema, JSON.parse(row.data));
      this.db.run("UPDATE quota_sources SET refresh=refresh+1,data=? WHERE instance=?", [
        JSON.stringify({ ...snapshot, lastAttemptAt: attemptedAt }),
        binding.source.instanceId,
      ]);
      return { source: binding, refreshId: row.refresh + 1, revision: snapshot.version };
    })();
  }
  applyQuotaObservation(observation: QuotaObservation) {
    const { source, refreshId, revision, outcome, attemptedAt, observedAt } = observation;
    return this.db.transaction(() => {
      const row = this.row(source.source.instanceId);
      if (!row || row.binding !== canonicalJson(source) || row.refresh !== refreshId) return false;
      const prior = v.parse(AccountQuotaSnapshotSchema, JSON.parse(row.data));
      if (prior.version !== revision) return false;
      const success = outcome === "success",
        windows = new Map(
          (success && observation.mode === "full" ? [] : prior.windows).map((w) => [w.id, w]),
        );
      if (success)
        for (const w of observation.windows) windows.set(w.id, { ...w, observedAt, stale: false });
      const snapshot = v.parse(AccountQuotaSnapshotSchema, {
        source: source.source,
        version: revision + 1,
        lastSuccessAt: success ? observedAt : prior.lastSuccessAt,
        lastAttemptAt: attemptedAt,
        outcome,
        state: success
          ? { kind: "fresh" }
          : { kind: prior.lastSuccessAt === null ? "unavailable" : "stale", reason: outcome },
        windows: [...windows.values()],
      });
      this.db.run("UPDATE quota_sources SET data=? WHERE instance=?", [
        JSON.stringify(snapshot),
        source.source.instanceId,
      ]);
      return true;
    })();
  }
  lastAutomaticAttempt() {
    return (
      this.db
        .query<{ attempted: number }, []>("SELECT attempted FROM quota_schedule WHERE singleton=1")
        .get()?.attempted ?? null
    );
  }
  attemptedAutomatically(at: number) {
    this.db.run("INSERT OR REPLACE INTO quota_schedule VALUES(1,?)", [at]);
  }
  recordUsage(fact: Fact) {
    const data = v.parse(factSchema, {
      ...fact,
      priceVersion: null,
      unpricedRecords: fact.amount === null ? 1 : 0,
    });
    this.db.run(
      `INSERT INTO usage_records VALUES(?,?,?,?,?,?) ON CONFLICT(thread,instance,session,scope,source) DO UPDATE SET data=excluded.data WHERE json_extract(excluded.data,'$.observedAt') >= json_extract(usage_records.data,'$.observedAt')`,
      [
        fact.threadId,
        fact.instanceId,
        fact.nativeSessionId,
        canonicalJson(fact.scope),
        fact.sourceId,
        JSON.stringify(data),
      ],
    );
  }
  buckets(threadId: ThreadId, custom: PriceTable | null, catalog: PriceTable | null = null) {
    return this.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM usage_records WHERE thread=? ORDER BY rowid",
      )
      .all(threadId)
      .map((row) => priceBucket(v.parse(factSchema, JSON.parse(row.data)), custom, catalog));
  }
}
