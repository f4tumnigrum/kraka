// Live cases 6; required groups ["1.", "2.", "3.", "4.", "5.", "6."]
// Live report junit
import { beforeAll, afterAll, test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  usageCase,
  usageBinaries,
  limits,
  failure,
  type PeerCall,
} from "../fixtures/account-usage-case";
import { accepted } from "../fixtures/first-send";
let dir: string, binaries: Awaited<ReturnType<typeof usageBinaries>>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kraka-usage-bin-"));
  binaries = await usageBinaries(dir);
}, 90000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
type Case = Awaited<ReturnType<typeof usageCase>>;
async function scenario(run: (fixture: Case) => Promise<void>) {
  const fixture = await usageCase(binaries);
  try {
    await run(fixture);
  } finally {
    await fixture.close();
  }
  return fixture.ledger.items;
}
const probes = (rows: PeerCall[]) => rows.filter((c) => c.method === "account/rateLimits/read");
const prompts = (rows: PeerCall[]) => rows.filter((c) => c.method === "turn/start");

test("1. A full weekly window (S-AUTO-031)", async () => {
  const rows = await scenario(async (f) => {
    await f.advance(1000);
    f.setResult("A", limits(100, 3));
    expect(await f.read()).toMatchObject({
      version: 0,
      windows: [],
      lastAttemptAt: null,
      lastSuccessAt: null,
    });
    const s = await f.refresh();
    expect(s).toMatchObject({
      version: 1,
      state: { kind: "fresh" },
      lastSuccessAt: 1000,
      windows: [{ resetAt: null }, { kind: "weekly", used: 100, remaining: 0, resetAt: 3000 }],
    });
    await f.advance(3000);
    expect(await f.read()).toMatchObject({
      state: { kind: "stale", reason: "resetReached" },
      windows: [
        { resetAt: null, stale: false },
        { remaining: 0, observedAt: 1000, stale: true },
      ],
    });
  });
  expect(probes(rows)).toHaveLength(1);
  expect(prompts(rows)).toBeEmpty();
}, 45000);
test("2. Failure after a dated success (S-AUTO-029)", async () => {
  const rows = await scenario(async (f) => {
    await f.grant();
    await f.advance(1000);
    f.setResult("A", limits(78, 8));
    await f.refresh();
    await f.advance(2000);
    const held = f.hold("A", failure);
    const first = f.refresh();
    await held.received();
    const second = f.refresh("A", f.two);
    await f.signals.until((m) => m.kind === "refreshJoined" && m.refresh === 2);
    held.release();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    expect(await f.read("A", f.two)).toEqual(a);
    expect(a).toMatchObject({
      version: 2,
      lastSuccessAt: 1000,
      lastAttemptAt: 2000,
      state: { kind: "stale", reason: "probeFailed" },
      windows: [{}, { observedAt: 1000, used: 78 }],
    });
  });
  expect(probes(rows)).toHaveLength(2);
}, 45000);
test("3. Failure on the first read (S-AUTO-030)", async () => {
  const rows = await scenario(async (f) => {
    expect(await f.two.client.rpc("executor.readQuota", { instanceId: "B" })).toMatchObject({
      kind: "rejected",
      failure: { kind: "missingPermission", permission: "thread.view" },
    });
    await f.advance(1000);
    expect(await f.read("B")).toMatchObject({ state: { kind: "neverObserved" } });
    f.setResult("B", failure);
    expect(await f.refresh("B")).toMatchObject({
      windows: [],
      lastSuccessAt: null,
      lastAttemptAt: 1000,
      state: { kind: "unavailable", reason: "probeFailed" },
    });
    expect(await f.read("A")).toMatchObject({ windows: [], lastAttemptAt: null });
  });
  expect(probes(rows).map((c) => c.account)).toEqual(["B"]);
}, 45000);
test("4. Price one actual record (S-AUTO-026)", async () => {
  const rows = await scenario(async (f) => {
    f.setResult("A", limits(78, 8));
    await f.refresh();
    const held = f.hold("A", limits(15, 5)),
      old = f.refresh();
    await held.received();
    await f.advance(1234);
    f.setTurn({ duplicate: true, fee: 3000000 });
    const release = f.holdDuplicate();
    const { thread, roundId, ended } = await f.startTurn();
    await f.signals.until((m) => m.kind === "usageCommitted" && m.round === roundId);
    held.release();
    await old;
    expect(await f.read()).toMatchObject({
      windows: [
        { used: 91, observedAt: 1234 },
        { used: 78, observedAt: 0 },
      ],
    });
    const byRound = async () =>
      (await f.usage(thread)).buckets.filter((x) => x.scope.kind === "round");
    expect(await byRound()).toMatchObject([
      {
        scope: { roundId },
        observedAt: 1234,
        unpricedRecords: 1,
        amount: null,
        counters: { uncachedInput: 1000000, output: 0 },
      },
    ]);
    const edit = {
      field: "modelRates",
      target: f.target,
      checkout: null,
      baseVersion: "0",
      change: {
        kind: "set",
        value: { kind: "modelRates", models: { fixture: { currency: "USD", uncachedInput: 2 } } },
      },
    };
    expect(
      String(
        accepted(await f.one.client.rpc("settings.write", edit), "settingSaved").readback
          .fieldVersion,
      ),
    ).toBe("1");
    expect(await byRound()).toMatchObject([
      {
        counters: { uncachedInput: 1000000 },
        amount: 2,
        currency: "USD",
        priceSource: "custom",
        priceVersion: "1",
        unpricedRecords: 0,
      },
    ]);
    release();
    await ended();
    expect(await byRound()).toMatchObject([{ counters: { uncachedInput: 1000000 }, amount: 2 }]);
    const fees = (await f.usage(thread)).buckets.filter((b) => b.priceSource === "reported");
    expect(fees).toMatchObject([{ scope: { kind: "session" }, amount: 3, currency: "USD" }]);
  });
  expect(prompts(rows)).toHaveLength(1);
  expect(rows.filter((c) => c.method === "account/usage/read").map((c) => c.session)).toEqual(
    prompts(rows).map((c) => c.session),
  );
}, 45000);
test("5. A quota-limited turn (J-5.5)", async () => {
  const rows = await scenario(async (f) => {
    f.setTurn({ limited: { reset: 3 } });
    const first = await f.turn();
    expect((await f.usage(first.thread)).limits).toMatchObject([
      {
        roundId: first.roundId,
        failure: "usageLimit",
        resetAt: 3000,
        autoResume: false,
        recovery: "waitingForManualRetry",
      },
    ]);
    await f.advance(3000);
    await f.refresh();
    await f.read();
    expect(prompts(f.ledger.items)).toHaveLength(1);
    f.setTurn({ limited: { reset: null } });
    const second = await f.turn(first.thread);
    expect(second.roundId).not.toBe(first.roundId);
    expect((await f.usage(first.thread)).limits).toMatchObject([
      { roundId: first.roundId },
      {
        roundId: second.roundId,
        resetAt: null,
        autoResume: false,
        recovery: "waitingForManualRetry",
      },
    ]);
    expect(await f.advance(303000)).toEqual({ subscriptions: 0, queries: 0, scheduledChecks: 0 });
  });
  expect(prompts(rows)).toHaveLength(2);
  expect(new Set(prompts(rows).map((c) => c.session)).size).toBe(1);
  expect(prompts(rows).map((c) => c.account)).toEqual(["A", "A"]);
}, 60000);
test("6. A late account observation", async () => {
  const rows = await scenario(async (f) => {
    const held = f.hold("A", limits(78, 5)),
      late = f.refresh();
    await held.received();
    await f.configure("A", "2");
    held.release();
    await f.signals.until((m) => m.kind === "refreshFinished" && m.outcome === "discarded");
    await late;
    const empty = await f.read("A", f.one, true);
    expect(empty).toMatchObject({
      source: { credentialVersion: "2" },
      version: 0,
      windows: [],
      outcome: null,
      lastAttemptAt: null,
    });
    await f.advance(1);
    await f.one.until(
      () => f.one.messages.some((m) => m.kind === "executor.quotaChanged"),
      "committed quota version",
    );
    expect(await f.read()).toMatchObject({ version: 1, windows: [{}, { used: 0 }] });
    await f.read("A", f.one, false);
    const detached = await f.signals.until((m) => m.kind === "detached");
    expect(detached.counts).toEqual({ subscriptions: 0, queries: 0, scheduledChecks: 0 });
    expect(await f.advance(300001)).toEqual(detached.counts);
  });
  expect(probes(rows).map((c) => c.account)).toEqual(["A", "A-replacement"]);
  expect(prompts(rows)).toBeEmpty();
}, 45000);
