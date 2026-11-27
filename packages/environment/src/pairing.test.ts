import { expect, test } from "bun:test";
import * as v from "valibot";
import {
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
const approval: PairingEvent = {
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
