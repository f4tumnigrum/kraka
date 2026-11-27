import { Database } from "bun:sqlite";
import { AccessStore } from "./access-store";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  EnvironmentIdentitySchema,
  DeviceKeyIdSchema,
  DeviceIdSchema,
  ProjectIdSchema,
  base64url,
  PairingPendingSchema,
  PairingExchangeSchema,
  PairingChallengeSchema,
  PrincipalIdSchema,
  AccessGrantIdSchema,
  PAIRING_LIMITS,
} from "@kraka/protocol";
import {
  createPairingInvite,
  transitionPairing,
  type PairingEvent,
  type PairingState,
} from "./pairing";
const pending = v.parse(PairingPendingSchema, {
  kind: "pairing.pending",
  environmentId: "env",
  inviteId: "invite",
  requestId: "request",
  deviceId: "new",
  publicKey: "A".repeat(87),
  permissions: ["thread.view"],
  target: { kind: "project", projectId: "project" },
  confirmationCode: "000123",
});
const initial = createPairingInvite(pending.environmentId, pending.inviteId, pending.target, 0);
const challenge = v.parse(PairingChallengeSchema, {
  kind: "pairing.challenge",
  requestId: pending.requestId,
  claimId: "claim",
  challengeId: "first",
  challenge: "B".repeat(43),
});
const exchange = v.parse(PairingExchangeSchema, {
  ...challenge,
  kind: "pairing.exchange",
  method: "pairing.exchange",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: pending.environmentId,
  inviteId: pending.inviteId,
  deviceId: pending.deviceId,
  deviceKeyId: "key",
  publicKey: pending.publicKey,
  signature: "C".repeat(86),
  sequence: 1,
});
const approver = {
  kind: "device" as const,
  deviceId: v.parse(PairingPendingSchema, { ...pending, deviceId: "owner-device" }).deviceId,
  principalId: v.parse(PrincipalIdSchema, "owner-device-principal"),
};
const rights = [{ permission: "thread.view", ceiling: "open" }] as const;
const approval: Extract<PairingEvent, { kind: "approve" }> = {
  kind: "approve",
  confirmationCode: pending.confirmationCode,
  selection: {
    requestId: pending.requestId,
    claimId: challenge.claimId,
    ownerId: v.parse(PrincipalIdSchema, "owner"),
    approvedBy: approver,
    rights,
  },
};
const consume: Extract<PairingEvent, { kind: "exchange" }> = {
  kind: "exchange",
  exchange,
  challenge,
  issuedAt: 1,
  verified: true,
  authority: {
    actor: approver,
    target: pending.target,
    inheritable: [{ permission: "thread.view", ceiling: "ask" }],
  },
  currentKey: null,
  principalId: v.parse(PrincipalIdSchema, "new-device"),
  grantIds: [v.parse(AccessGrantIdSchema, "grant")],
};
function step(state: PairingState, event: PairingEvent, now = 2) {
  const r = transitionPairing(state, event, now);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.state;
}
const applied = step(initial, { kind: "apply", pending });
const selected = step(applied, approval);
test("only the selected proof consumes the invitation and commits the narrowed grant with the key", () => {
  expect(step(applied, { kind: "apply", pending })).toBe(applied);
  expect(
    transitionPairing(
      applied,
      { kind: "apply", pending: { ...pending, publicKey: "D".repeat(87) } },
      3,
    ).kind,
  ).toBe("rejected");
  expect(transitionPairing(selected, { ...consume, verified: false }, 2).kind).toBe("rejected");
  expect(
    transitionPairing(selected, consume, consume.issuedAt + PAIRING_LIMITS.challengeMs).kind,
  ).toBe("rejected");
  expect(transitionPairing(initial, { kind: "apply", pending }, initial.expiresAt).kind).toBe(
    "rejected",
  );
  expect(transitionPairing(step(selected, { kind: "cancel" }), consume, 2).kind).toBe("rejected");
  const revoked = transitionPairing(selected, { ...consume, authority: null }, 2);
  expect(revoked.state.kind).toBe("cancelled");
  const consumed = step(selected, consume);
  expect(consumed.kind).toBe("consumed");
  if (consumed.kind !== "consumed") throw new Error("Missing registration");
  expect(consumed.grants.map((g) => g.modeCeiling)).toEqual(["ask"]);
  expect(consumed.completed.principal.ownerId).toBe(approval.selection.ownerId);
  expect(transitionPairing(consumed, { kind: "cancel" }, 3).kind).toBe("rejected");
});
test("recovery after invite expiry requires the original live key and a fresh challenge", () => {
  const state = step(selected, consume);
  if (state.kind !== "consumed") throw new Error("Missing registration");
  const now = initial.expiresAt + 1;
  const fresh = v.parse(PairingChallengeSchema, {
    ...challenge,
    challengeId: "second",
    challenge: "D".repeat(43),
  });
  const recovery = {
    ...consume,
    currentKey: state.completed.deviceKey,
    issuedAt: now,
    challenge: fresh,
    exchange: { ...exchange, challengeId: fresh.challengeId, challenge: fresh.challenge },
  };
  expect(step(state, recovery, now)).toBe(state);
  if (state.completed.deviceKey.state.kind !== "usable") throw Error("Missing usable registration");
  const expiry = state.completed.deviceKey.state.expiresAt;
  expect(transitionPairing(state, { ...recovery, issuedAt: expiry }, expiry)).toMatchObject({
    kind: "rejected",
    reason: "expired",
  });
  expect(transitionPairing(state, { ...recovery, currentKey: null }, now).kind).toBe("rejected");
  expect(
    transitionPairing(
      state,
      { ...recovery, exchange: { ...recovery.exchange, publicKey: "E".repeat(87) } },
      now,
    ).kind,
  ).toBe("rejected");
  expect(transitionPairing(state, { ...recovery, exchange, challenge }, now).kind).toBe("rejected");
});

test("the SQLite writer commits the winning cancellation or exchange once, including audit rows", async () => {
  const db = new Database(":memory:");
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
  const identity = v.parse(EnvironmentIdentitySchema, { id: "env", keyVersion: 1, publicKey });
  const confirmed = { present: async () => true, approve: async () => true };
  const ownerId = v.parse(DeviceIdSchema, "owner-device"),
    keyId = v.parse(DeviceKeyIdSchema, "owner-key");
  const counts = () =>
    db
      .query<{ devices: number; grants: number; changes: number }, []>(
        "SELECT (SELECT count(*) FROM devices) AS devices,(SELECT count(*) FROM grants) AS grants,(SELECT count(*) FROM changes) AS changes",
      )
      .get();
  const store = new AccessStore(db, identity, () => 2);
  try {
    await store.confirm(
      { kind: "bootstrap", environment: identity, publicKey, deviceId: ownerId, keyId },
      confirmed,
    );
    const owner = store.device(ownerId);
    if (!owner) throw Error("Owner not registered");
    const actor = { kind: "device" as const, deviceId: ownerId, principalId: owner.principal.id };
    store.provisionProject(v.parse(ProjectIdSchema, "project"));
    const { authority: _authority, currentKey: _currentKey, ...intent } = consume;
    async function prepare(id: string) {
      const app = v.parse(PairingPendingSchema, { ...pending, inviteId: id, requestId: id });
      const invite = createPairingInvite(identity.id, app.inviteId, app.target, 0);
      expect(await store.create(invite)).toBe("created");
      expect(await store.create(invite)).toBe("alreadyExists");
      await store.apply(app.inviteId, { kind: "apply", pending: app }, 2);
      await store.apply(
        app.inviteId,
        {
          ...approval,
          selection: {
            ...approval.selection,
            approvedBy: actor,
            ownerId: actor.principalId,
            requestId: app.requestId,
          },
        },
        2,
      );
      return {
        id: app.inviteId,
        exchange: {
          ...intent,
          challenge: { ...challenge, requestId: app.requestId },
          exchange: { ...exchange, requestId: app.requestId, inviteId: app.inviteId },
        },
      };
    }
    const cancelFirst = await prepare("cancel-wins");
    const [, lost] = await Promise.all([
      store.apply(cancelFirst.id, { kind: "cancel" }, 2),
      store.apply(cancelFirst.id, cancelFirst.exchange, 2),
    ]);
    expect(lost).toMatchObject({ kind: "rejected", reason: "cancelled" });
    expect(counts()).toEqual({ devices: 1, grants: 9, changes: 9 });
    const exchangeFirst = await prepare("exchange-wins");
    db.exec(
      "CREATE TRIGGER stop_grant BEFORE INSERT ON grants BEGIN SELECT RAISE(ABORT,'unavailable'); END",
    );
    await expect(store.apply(exchangeFirst.id, exchangeFirst.exchange, 2)).rejects.toThrow(
      "unavailable",
    );
    expect((await store.read(exchangeFirst.id))?.kind).toBe("selected");
    expect(counts()).toEqual({ devices: 1, grants: 9, changes: 9 });
    db.exec("DROP TRIGGER stop_grant");
    const [won, cancelled] = await Promise.all([
      store.apply(exchangeFirst.id, exchangeFirst.exchange, 2),
      store.apply(exchangeFirst.id, { kind: "cancel" }, 2),
    ]);
    expect(won?.state.kind).toBe("consumed");
    expect(cancelled).toMatchObject({ kind: "rejected", reason: "alreadyExchanged" });
    expect(counts()).toEqual({ devices: 2, grants: 10, changes: 10 });
  } finally {
    db.close();
  }
});
