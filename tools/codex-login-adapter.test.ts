import { test, expect } from "bun:test";
import * as v from "valibot";
import { createCodexAdapter, probeCodex } from "../packages/adapter-codex/src";
import type { ActionPermit, LoginObserver, LoginFlow } from "@kraka/environment";
import { CommandIdSchema, DeliveryIdSchema, EnvironmentSessionIdSchema } from "@kraka/protocol";
import { withState, within } from "./fixtures/replay-process";
import { loginPeer, type Profile } from "./fixtures/login-control";

test("The native login ID belongs to its instance across cancellation, callback and fresh account reads", async () => {
  await withState(async (dir) => {
    const peer = await loginPeer(dir);
    const children: Promise<void>[] = [],
      stop = new AbortController();
    try {
      async function start(id: Profile, interaction: LoginFlow["interaction"]) {
        const { reg, launch } = await peer.profile(id);
        const probe = await probeCodex(reg, launch, undefined, peer.now);
        expect(probe.declaration.readiness.authenticated.state).toBe("no");
        expect(probe.declaration.matrix.startLogin.kind).toBe("native");
        const instance = { family: "codex" as const, instanceId: reg.instanceId };
        const adapter = createCodexAdapter(instance, launch, probe, 0, peer.now);
        const permit = <C extends "startLogin" | "checkAuthentication" | "listModels">(
          capability: C,
        ): ActionPermit<"codex", C> => {
          const support = probe.declaration.matrix[capability];
          if (support.kind !== "native") throw Error("Missing login capability");
          return { ...instance, capability, capabilityVersion: probe.declaration.version, support };
        };
        const flow: LoginFlow = {
          flowId: v.parse(CommandIdSchema, "flow-" + id),
          instanceId: reg.instanceId,
          credential: reg.credential,
          configVersion: reg.version,
          interaction,
          expectedAccount: id + "@example.invalid",
          ownerSessionId: v.parse(EnvironmentSessionIdSchema, "device-" + id),
          expiresAt: peer.now() + 600000,
        };
        const callback = Promise.withResolvers<string>();
        const observer: LoginObserver = {
          signal: stop.signal,
          authorize: () => true,
          completed: (native, success) => {
            if (success) callback.resolve(native);
          },
          disconnected: () => {},
          track: (p) => children.push(p),
        };
        const deliveryId = v.parse(DeliveryIdSchema, flow.flowId);
        const r = await adapter.invoke(instance, permit("startLogin"), {
          kind: "service",
          capability: "startLogin",
          deliveryId,
          request: { kind: "login", flow, observer },
        });
        if (r.kind !== "ok") throw Error("Login rejected");
        const result = r.value.result;
        expect(result.status.kind).toBe(interaction);
        expect(result.nativeLoginId).toBe(
          await within(peer.profiles[id].observed.promise, 5000, "Provider login ID"),
        );
        return {
          result,
          flow,
          callback,
          reg,
          launch,
          probe,
          cancel: () =>
            adapter.invoke(instance, permit("startLogin"), {
              kind: "service",
              capability: "startLogin",
              deliveryId,
              request: { kind: "cancelLogin", flow, nativeLoginId: result.nativeLoginId },
            }),
          verify: () =>
            adapter.invoke(instance, permit("checkAuthentication"), {
              kind: "service",
              capability: "checkAuthentication",
              deliveryId,
              request: { kind: "checkAuthentication", authorize: () => true },
            }),
          catalog: () =>
            adapter.invoke(instance, permit("listModels"), {
              kind: "service",
              capability: "listModels",
              deliveryId,
              request: {
                kind: "listModels",
                verifiedAccount: {
                  expectedAccount: flow.expectedAccount,
                  authorize: () => true,
                  authenticationPermit: permit("checkAuthentication"),
                },
              },
            }),
        };
      }
      peer.profiles.A.expiresAt = peer.now() + 2000;
      const a = await start("A", "browser"),
        b = await start("B", "deviceCode");
      expect(a.result.expiresAt).toBe(peer.profiles.A.expiresAt);
      expect(b.result.expiresAt).toBe(peer.now() + 600000);
      expect((await a.cancel()).kind).toBe("ok");
      peer.profiles.B.callback.resolve(true);
      expect(await within(b.callback.promise, 5000, "B completion")).toBe(b.result.nativeLoginId);
      peer.profiles.B.account = b.flow.expectedAccount;
      peer.profiles.B.hold = Promise.withResolvers<void>();
      const verifying = b.verify();
      await peer.ledger.until((e) => e.instance === "B" && e.method === "accountReadHeld");
      peer.profiles.A.callback.resolve(true);
      expect(await within(a.callback.promise, 5000, "Late A completion")).toBe(
        a.result.nativeLoginId,
      );
      peer.profiles.B.hold.resolve();
      expect(await verifying).toMatchObject({
        kind: "ok",
        value: { result: { status: { state: "yes" }, account: b.flow.expectedAccount } },
      });
      expect(await b.catalog()).toMatchObject({
        kind: "ok",
        value: { result: { models: [{ id: "B-first" }, { id: "B-second" }] } },
      });
      peer.profiles.B.account = a.flow.expectedAccount;
      expect(await b.catalog()).toMatchObject({ kind: "rejected" });
      peer.profiles.A.accountFailure = true;
      expect(await a.verify()).toMatchObject({
        kind: "ok",
        value: { result: { status: { state: "unknown" }, account: null } },
      });
      for (const item of [a, b])
        expect(
          await within(
            peer.profiles[item.reg.instanceId === "A" ? "A" : "B"].sent.promise,
            5000,
            "Callback sent",
          ),
        ).toBe(item.result.nativeLoginId);
      expect(
        peer.ledger.items.filter((e) =>
          ["spawn.mismatch", "cancel.mismatch", "turn/start"].includes(e.method),
        ),
      ).toHaveLength(0);
      expect(
        peer.ledger.items.filter((e) => e.method === "model/list").map((e) => e.instance),
      ).toEqual(["B"]);
      expect(JSON.stringify(peer.ledger.items)).not.toMatch(
        /fixture-secret|fixture-private|fixture-code/,
      );
    } finally {
      peer.release();
      stop.abort();
      try {
        await Promise.all(children);
      } finally {
        await peer.close();
      }
    }
  });
}, 60000);

test("A failed native catalog refresh retains its original observation time", async () => {
  await withState(async (dir) => {
    const peer = await loginPeer(dir);
    try {
      const { reg, launch } = await peer.profile("B");
      peer.profiles.B.account = "B@example.invalid";
      const t0 = peer.now(),
        ready = await probeCodex(reg, launch, undefined, peer.now);
      expect(ready.models?.models.map((m) => m.id)).toEqual(["B-first", "B-second"]);
      expect(ready.models?.checkedAt).toBe(t0);
      peer.setTime(t0 + 300001);
      peer.profiles.B.catalogFailure = true;
      const failed = await probeCodex(reg, launch, ready, peer.now);
      expect(failed.models).toEqual(ready.models);
      expect(failed.attemptedAt).toBe(peer.now());
      expect(failed.declaration.readiness.model.state).toBe("unknown");
      peer.profiles.B.account = "other@example.invalid";
      expect((await probeCodex(reg, launch, ready, peer.now)).models).toBeNull();
    } finally {
      await peer.close();
    }
  });
}, 60000);
