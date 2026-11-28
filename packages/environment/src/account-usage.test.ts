import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  ExecutorInstanceIdSchema,
  ObjectVersionSchema,
  NativeSessionIdSchema,
  ThreadIdSchema,
  RoundIdSchema,
  type QuotaWindow,
} from "@kraka/protocol";
import { AccountUsageStore, accountUsageTables, type AccountBinding } from "./account-usage";
import { QuotaRefresh, type QuotaReply, type QuotaTarget, type QuotaSignal } from "./quota-refresh";
import { CaseQuotaClock } from "../../../tools/fixtures/quota-clock";
const version = v.parse(ObjectVersionSchema, "1"),
  instanceId = v.parse(ExecutorInstanceIdSchema, "fixture");
const binding: AccountBinding = {
  source: {
    instanceId,
    account: "account-A",
    credentialVersion: version,
    endpoint: "codex/app-server",
  },
  registrationVersion: version,
  credentialKey: "fixture-A",
};
const weekly: QuotaWindow = {
  id: "weekly",
  kind: "weekly",
  unit: "percent",
  durationMinutes: 10080,
  used: 100,
  remaining: 0,
  resetAt: 200,
};
const ok: QuotaReply = {
  outcome: "success",
  account: "account-A",
  mode: "full",
  windows: [weekly],
};
let directory: string,
  db: Database,
  store: AccountUsageStore,
  clock: CaseQuotaClock,
  service: QuotaRefresh,
  signals: QuotaSignal[];
function openDatabase() {
  db = new Database(join(directory, "account.sqlite"), { create: true, strict: true });
  db.exec(accountUsageTables);
  store = new AccountUsageStore(db);
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "kraka-usage-"));
  openDatabase();
  clock = new CaseQuotaClock();
  signals = [];
  service = new QuotaRefresh(store, clock, (e) => signals.push(e));
});
afterEach(async () => {
  await service.close();
  db.close(true);
  rmSync(directory, { recursive: true, force: true });
});
test("One million uncached tokens cost two dollars at the stated rate.", () => {
  const threadId = v.parse(ThreadIdSchema, "thread"),
    r = {
      instanceId,
      threadId,
      nativeSessionId: v.parse(NativeSessionIdSchema, "session"),
      sourceId: "one",
      scope: { kind: "round" as const, roundId: v.parse(RoundIdSchema, "round") },
      model: "fixture",
      observedAt: 0,
      counters: {
        uncachedInput: 1_000_000,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        total: 1_000_000,
      },
      amount: null,
      currency: null,
      priceSource: "unknown" as const,
    };
  store.recordUsage(r);
  store.recordUsage(r);
  expect(
    store.buckets(threadId, {
      models: { fixture: { uncachedInput: 2, currency: "USD" } },
      version,
    }),
  ).toMatchObject([
    {
      amount: 2,
      currency: "USD",
      priceVersion: version,
      priceSource: "custom",
      unpricedRecords: 0,
    },
  ]);
  db.close(true);
  openDatabase();
  expect(store.buckets(threadId, null)).toMatchObject([
    { amount: null, unpricedRecords: 1, counters: { uncachedInput: 1_000_000 } },
  ]);
  store.recordUsage({
    ...r,
    scope: { kind: "session" },
    amount: 0,
    currency: "USD",
    priceSource: "reported",
  });
  expect(store.buckets(threadId, null)).toMatchObject([
    { amount: null },
    { amount: 0, scope: { kind: "session" }, priceSource: "reported" },
  ]);
  const missing = { models: { fixture: { output: 3, currency: "USD" } }, version };
  expect(store.buckets(threadId, missing)).toMatchObject([{ amount: null }, { amount: 0 }]);
});
test("Two devices share one refresh.", async () => {
  const held = Promise.withResolvers<QuotaReply>(),
    received = Promise.withResolvers<void>();
  let reads = 0;
  const resolve = () => ({
    binding,
    query: () => {
      reads++;
      received.resolve();
      return held.promise;
    },
  });
  const a = service.refresh(resolve);
  await received.promise;
  const b = service.refresh(resolve);
  expect(signals).toContainEqual({ kind: "refreshJoined", account: "account-A", refresh: 1 });
  held.resolve(ok);
  const [first, second] = await Promise.all([a, b]);
  expect(reads).toBe(1);
  expect(first).toEqual(second);
  expect(second).toMatchObject({ version: 1, windows: [{ remaining: 0 }] });
});
test("An old window does not refill itself.", async () => {
  let target: QuotaTarget = { binding, query: async () => ok };
  const resolve = () => target;
  await clock.advanceTo(100);
  await service.refresh(resolve);
  await clock.advanceTo(200);
  expect(service.read(resolve)).toMatchObject({
    state: { kind: "stale", reason: "resetReached" },
    windows: [{ remaining: 0, stale: true, observedAt: 100 }],
  });
  target = { binding, query: async () => ({ outcome: "probeFailed" }) };
  await service.refresh(resolve);
  db.close(true);
  openDatabase();
  expect(store.read(binding, 201)).toMatchObject({
    lastSuccessAt: 100,
    lastAttemptAt: 200,
    outcome: "probeFailed",
    windows: [{ remaining: 0, stale: true, observedAt: 100 }],
  });
});
test("Failed first probe, partial replacement, empty success and stale revisions survive replay", () => {
  store.bind(binding);
  const apply = (
    t: number,
    outcome: "success" | "unsupported",
    mode: "full" | "partial",
    windows: QuotaWindow[],
  ) => {
    const observation = {
      ...store.begin(binding, t),
      observedAt: t,
      attemptedAt: t,
      outcome,
      mode,
      windows,
    };
    expect(store.applyQuotaObservation(observation)).toBe(true);
    expect(store.applyQuotaObservation(observation)).toBe(false);
  };
  apply(0, "unsupported", "full", []);
  expect(store.read(binding, 0)).toMatchObject({
    state: { kind: "unavailable", reason: "unsupported" },
    lastSuccessAt: null,
    windows: [],
  });
  apply(1, "success", "full", [weekly]);
  apply(2, "success", "partial", [
    { ...weekly, id: "other", resetAt: null, remaining: null, used: null },
  ]);
  expect(store.read(binding, 2).windows).toMatchObject([
    { observedAt: 1, remaining: 0 },
    { observedAt: 2, remaining: null, resetAt: null },
  ]);
  apply(3, "success", "full", []);
  expect(store.read(binding, 3)).toMatchObject({
    state: { kind: "fresh" },
    lastSuccessAt: 3,
    windows: [],
  });
});
test("Credential rotation discards the old reply and detaching stops automatic checks", async () => {
  const held = Promise.withResolvers<QuotaReply>(),
    received = Promise.withResolvers<void>();
  let target: QuotaTarget = {
    binding,
    query: () => {
      received.resolve();
      return held.promise;
    },
  };
  const resolve = () => target;
  const pending = service.refresh(resolve);
  await received.promise;
  target = {
    binding: {
      ...binding,
      source: {
        ...binding.source,
        account: "B",
        credentialVersion: v.parse(ObjectVersionSchema, "2"),
      },
    },
    query: async () => ({ outcome: "probeFailed" }),
  };
  held.resolve(ok);
  expect(await pending).toMatchObject({
    version: 0,
    windows: [],
    lastAttemptAt: null,
    state: { kind: "neverObserved" },
  });
  expect(signals).toContainEqual({
    kind: "refreshFinished",
    account: "account-A",
    refresh: 1,
    outcome: "discarded",
  });
  const snapshots: number[] = [];
  const detach = service.subscribe(resolve, (s) => snapshots.push(s.version));
  await clock.advanceTo(0);
  expect(snapshots).toEqual([0, 1]);
  await clock.advanceTo(299999);
  expect(snapshots).toEqual([0, 1]);
  await clock.advanceTo(300000);
  expect(snapshots).toEqual([0, 1, 2]);
  detach();
  await clock.advanceTo(700000);
  expect(service.counts()).toEqual({ subscriptions: 0, queries: 0, scheduledChecks: 0 });
  expect(snapshots).toEqual([0, 1, 2]);
});
test("The account deadline records one failed attempt", async () => {
  let queries = 0;
  const resolve = () => ({
    binding,
    query: () => {
      queries++;
      return new Promise<QuotaReply>(() => {});
    },
  });
  const pending = service.refresh(resolve);
  await clock.advanceTo(10000);
  expect(await pending).toMatchObject({
    outcome: "probeFailed",
    lastSuccessAt: null,
    lastAttemptAt: 0,
  });
  expect(queries).toBe(1);
});
