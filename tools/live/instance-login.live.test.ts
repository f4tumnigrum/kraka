// Live cases 5; required groups ["1.", "2.", "3.", "4.", "5."]
// Live junit live.xml
import { test, expect } from "bun:test";
import { loginCase } from "../fixtures/instance-login";
import { accepted } from "../fixtures/first-send";
import { sampleRequest, within } from "../fixtures/replay-process";

test("1. Configuration and login (J-1.2, J-1.3)", async () => {
  await loginCase(async (f) => {
    for (const id of ["A", "B"] as const) {
      expect(await f.configure(id)).toMatchObject({ instanceId: id, version: "1" });
      const summary = await f.refresh(id);
      expect(summary).toMatchObject({
        instanceId: id,
        binaryVersion: "0.159.0",
        versionAdvisory: null,
        compatibilityAdvisory: null,
        snapshot: { family: "codex", instanceId: id },
        readiness: {
          configured: { state: "yes" },
          installed: { state: "yes" },
          authenticated: { state: "no" },
          model: { state: "unknown" },
          operation: { state: "unknown" },
        },
      });
      expect(summary.variables).toContainEqual({ name: "SYNTHETIC_CODEX", kind: "secret" });
    }
    f.peer.profiles.A.expiresAt = f.peer.now() + 5000;
    const a = await f.start("A"),
      b = await f.start("B");
    expect(a).toMatchObject({
      phase: "browser",
      expiresAt: f.peer.profiles.A.expiresAt,
      interaction: { kind: "browser", url: expect.stringContaining("fixture-private-A") },
    });
    expect(b).toMatchObject({
      phase: "deviceCode",
      expiresAt: f.peer.now() + 600000,
      interaction: { kind: "deviceCode", userCode: expect.stringContaining("fixture-code-B") },
    });
    expect(await f.start("A", a.flowId)).toEqual(a);
    expect((await f.read("B", b.flowId, "A")).interaction).toBeNull();
    expect((await f.read("A", a.flowId, "B")).interaction).toBeNull();
    expect(f.peer.ledger.items.filter((e) => e.method === "account/login/start")).toHaveLength(2);
  });
}, 90000);
test("2. Cancelled flow and held verification", async () => {
  await loginCase(async (f) => {
    for (const id of ["A", "B"] as const) {
      await f.configure(id);
      await f.refresh(id);
    }
    const a = await f.start("A"),
      b = await f.start("B");
    expect((await f.cancel("A", a.flowId, "B")).kind).toBe("rejected");
    expect(accepted(await f.cancel("A", a.flowId), "instanceLogin").phase).toBe("cancelled");
    const profile = f.peer.profiles.B;
    profile.hold = Promise.withResolvers<void>();
    profile.callback.resolve(true);
    await f.peer.ledger.until((e) => e.instance === "B" && e.method === "accountReadHeld");
    f.peer.profiles.A.callback.resolve(true);
    await Promise.all([
      f.handled(a.flowId, "discarded"),
      within(f.peer.profiles.A.sent.promise, 5000, "A callback sent"),
      within(profile.sent.promise, 5000, "B callback sent"),
    ]);
    expect(await f.read("A", a.flowId)).toMatchObject({ phase: "cancelled", interaction: null });
    expect(await f.read("B", b.flowId)).toMatchObject({ phase: "verifying", interaction: null });
    profile.account = "B@example.invalid";
    profile.hold.resolve();
    await f.handled(b.flowId, "applied");
    expect((await f.read("B", b.flowId)).phase).toBe("authenticated");
    const ready = await f.refresh("B", "A"),
      other = await f.refresh("A", "B");
    expect(ready.models?.models.map((m) => m.id)).toEqual(["B-first", "B-second"]);
    expect(ready.readiness.authenticated.state).toBe("yes");
    expect(other.readiness.authenticated.state).toBe("no");
    expect(other.models).toBeNull();
    expect(
      f.peer.ledger.items.filter((e) => e.method === "model/list").map((e) => e.instance),
    ).toEqual(["B"]);
  });
}, 90000);
test("3. Expiry", async () => {
  await loginCase(async (f) => {
    for (const id of ["A", "B"] as const) {
      await f.configure(id);
      if (id === "A") f.peer.profiles.A.expiresAt = f.peer.now() + 100;
      const from = f.peer.now();
      const r = await f.start(id);
      expect(r.expiresAt).toBe(from + (id === "A" ? 100 : 600000));
      await f.advance(r.expiresAt - 1);
      expect((await f.read(id, r.flowId)).phase).toBe(id === "A" ? "browser" : "deviceCode");
      await f.advance(r.expiresAt);
      expect(await f.read(id, r.flowId)).toMatchObject({ phase: "expired", interaction: null });
      f.peer.profiles[id].callback.resolve(true);
      await f.handled(r.flowId, "discarded");
      expect((await f.read(id, r.flowId)).phase).toBe("expired");
    }
  });
}, 90000);
test("4. Unknown login at model start (S-EXEC-008)", async () => {
  await loginCase(async (f) => {
    f.peer.profiles.A.accountFailure = true;
    await f.configure("A");
    const r = await f.clients.A.rpc("thread.start", {
      projectId: f.projectId,
      instanceId: "A",
      worktreeId: null,
      content: sampleRequest.input,
    });
    expect(r).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
    const read = await f.refresh("A");
    expect(read).toMatchObject({
      authenticationReason: "Account probe inconclusive",
      readiness: { installed: { state: "yes" }, authenticated: { state: "unknown" } },
    });
    await f.close();
    expect(
      f.peer.ledger.items.filter((e) => ["turn/start", "account/login/start"].includes(e.method)),
    ).toEqual([]);
    expect(f.peer.ledger.items.filter((e) => e.method === "account/read")).toHaveLength(1);
  });
}, 90000);
test("5. Failed refresh after ready (S-EXEC-022)", async () => {
  await loginCase(async (f) => {
    for (const id of ["A", "B"] as const) {
      f.peer.profiles[id].account = id + "@example.invalid";
      await f.configure(id);
    }
    const a = await f.refresh("A"),
      b = await f.refresh("B"),
      t0 = f.peer.now();
    expect(b.models?.checkedAt).toBe(t0);
    expect(b.models?.models.map((m) => m.id)).toEqual(["B-first", "B-second"]);
    await f.advance(t0 + 1234);
    f.peer.profiles.B.catalogFailure = true;
    const failed = await f.refresh("B", "B", true);
    expect(failed.models).toEqual(b.models);
    expect(failed).toMatchObject({
      attemptedAt: t0 + 1234,
      readiness: { model: { state: "unknown" } },
    });
    const unchanged = await f.refresh("A", "B");
    expect(unchanged).toEqual(a);
    expect(unchanged.models?.models.map((m) => m.id)).toEqual(["A-first", "A-second"]);
  });
}, 90000);
