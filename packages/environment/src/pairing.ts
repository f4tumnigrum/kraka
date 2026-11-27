import {
  PAIRING_LIMITS,
  type AuthorizationTarget,
  type PairingPending,
  type PairingExchange,
  type PairingChallenge,
  type ConnectionChallengeId,
  type DevicePairingResult,
  type PermissionGrant,
  type DeviceKey,
  type AccessGrantId,
  type PrincipalId,
  type PairingClaimId,
  type PairingRequestId,
  type PairingInviteId,
  type EnvironmentId,
  type DeviceId,
  type PermissionItem,
  type PermissionMode,
  type EnvironmentIdentity,
} from "@kraka/protocol";

type Completed = Extract<DevicePairingResult, { kind: "pairing.completed" }>;
type Rejection = Extract<DevicePairingResult, { kind: "pairing.rejected" }>["reason"];
type Selection = {
  ownerId: PrincipalId;
  requestId: PairingRequestId;
  claimId: PairingClaimId;
  approvedBy: Extract<PermissionGrant["grantedBy"], { kind: "device" }>;
  rights: readonly { permission: PermissionItem; ceiling: PermissionMode }[];
};
type Invite = {
  environmentId: EnvironmentId;
  inviteId: PairingInviteId;
  target: AuthorizationTarget;
  expiresAt: number;
  applications: readonly PairingPending[];
};
export type PairingState = Invite &
  (
    | { kind: "open" }
    | { kind: "selected"; selection: Selection }
    | { kind: "cancelled" }
    | {
        kind: "consumed";
        consumedChallengeId: ConnectionChallengeId;
        selection: Selection;
        completed: Completed;
        grants: readonly PermissionGrant[];
      }
  );
/** The verifier supplies fresh connection-bound proof. The writer reads current authority or key state inside the exchange transaction. */
export type PairingEvent =
  | { kind: "apply"; pending: PairingPending }
  | { kind: "approve"; selection: Selection; confirmationCode: string }
  | { kind: "cancel" }
  | {
      kind: "exchange";
      exchange: PairingExchange;
      challenge: PairingChallenge;
      issuedAt: number;
      verified: boolean;
      authority: {
        actor: Selection["approvedBy"];
        target: AuthorizationTarget;
        inheritable: readonly { permission: PermissionItem; ceiling: PermissionMode }[];
      } | null;
      principalId: PrincipalId;
      grantIds: readonly AccessGrantId[];
      currentKey: DeviceKey | null;
    };
type Result =
  | { kind: "ok"; state: PairingState; completed?: Completed }
  | { kind: "rejected"; reason: Rejection; state: PairingState };
function sameTarget(a: AuthorizationTarget, b: AuthorizationTarget) {
  switch (a.kind) {
    case "environment":
      return b.kind === "environment" && a.environmentId === b.environmentId;
    case "project":
      return b.kind === "project" && a.projectId === b.projectId;
    case "thread":
      return b.kind === "thread" && a.threadId === b.threadId;
  }
}
const rank = { ask: 0, edits: 1, open: 2 } as const;
export function createPairingInvite(
  environmentId: EnvironmentId,
  inviteId: PairingInviteId,
  target: AuthorizationTarget,
  now: number,
): Extract<PairingState, { kind: "open" }> {
  return {
    kind: "open",
    environmentId,
    inviteId,
    target,
    expiresAt: now + PAIRING_LIMITS.inviteMs,
    applications: [],
  };
}
/** Persist with an expected-version check. Consumption, key creation and all grants commit as one change. */
export function transitionPairing(state: PairingState, event: PairingEvent, now: number): Result {
  const reject = (reason: Rejection): Result => ({ kind: "rejected", state, reason });
  const ok = (next: PairingState): Result => ({ kind: "ok", state: next });
  if (event.kind === "exchange") {
    const { exchange: x, challenge: c } = event;
    if (
      !event.verified ||
      x.sequence !== 1 ||
      x.environmentId !== state.environmentId ||
      x.inviteId !== state.inviteId ||
      x.requestId !== c.requestId ||
      x.challengeId !== c.challengeId ||
      x.challenge !== c.challenge ||
      x.claimId !== c.claimId ||
      event.issuedAt > now ||
      now - event.issuedAt >= PAIRING_LIMITS.challengeMs
    )
      return reject("invalidProof");
    if (state.kind === "consumed") {
      const original = state.completed;
      if (x.requestId !== original.requestId) return reject("alreadyExchanged");
      if (
        x.challengeId === state.consumedChallengeId ||
        x.claimId !== state.selection.claimId ||
        x.publicKey !== original.deviceKey.publicKey ||
        x.deviceId !== original.deviceKey.deviceId ||
        x.deviceKeyId !== original.deviceKey.id
      )
        return reject("invalidProof");
      const key = event.currentKey;
      if (
        !key ||
        key.id !== x.deviceKeyId ||
        key.publicKey !== x.publicKey ||
        key.deviceId !== x.deviceId ||
        key.state.kind !== "usable" ||
        now >= key.state.expiresAt
      )
        return reject("expired");
      return { kind: "ok", state, completed: original };
    }
  }
  if (state.kind === "consumed") return reject("alreadyExchanged");
  if (event.kind === "cancel") return ok({ ...state, kind: "cancelled" });
  if (state.kind === "cancelled") return reject("cancelled");
  if (now >= state.expiresAt) return reject("expired");
  switch (event.kind) {
    case "apply": {
      const a = event.pending;
      if (
        a.inviteId !== state.inviteId ||
        a.environmentId !== state.environmentId ||
        !sameTarget(a.target, state.target) ||
        !/^\d{6}$/.test(a.confirmationCode) ||
        new Set(a.permissions).size !== a.permissions.length ||
        (a.target.kind !== "environment" && a.permissions.includes("environment.upgrade"))
      )
        return reject("invalidProof");
      const prior = state.applications.find((p) => p.requestId === a.requestId);
      if (prior)
        return prior.publicKey === a.publicKey &&
          prior.deviceId === a.deviceId &&
          prior.permissions.length === a.permissions.length &&
          a.permissions.every((right) => prior.permissions.includes(right))
          ? ok(state)
          : reject("invalidProof");
      if (state.kind === "selected") return reject("notSelected");
      if (state.applications.some((p) => p.confirmationCode === a.confirmationCode))
        return reject("invalidProof");
      return ok({ ...state, applications: [...state.applications, a] });
    }
    case "approve": {
      const { selection } = event;
      const a = state.applications.find((p) => p.requestId === selection.requestId);
      if (
        !a ||
        a.confirmationCode !== event.confirmationCode ||
        !selection.rights.length ||
        new Set(selection.rights.map((r) => r.permission)).size !== selection.rights.length ||
        selection.rights.some((r) => !a.permissions.includes(r.permission))
      )
        return reject("invalidProof");
      if (state.kind === "selected") return reject("notSelected");
      return ok({ ...state, kind: "selected", selection });
    }
    case "exchange": {
      const x = event.exchange;
      if (
        state.kind !== "selected" ||
        state.selection.requestId !== x.requestId ||
        state.selection.claimId !== x.claimId
      )
        return reject("notSelected");
      const a = state.applications.find((item) => item.requestId === x.requestId);
      if (!a || a.publicKey !== x.publicKey || a.deviceId !== x.deviceId)
        return reject("invalidProof");
      const { rights, approvedBy } = state.selection;
      if (
        event.grantIds.length !== rights.length ||
        new Set(event.grantIds).size !== rights.length ||
        event.currentKey !== null
      )
        return reject("invalidProof");
      const grants: PermissionGrant[] = [];
      for (const [i, right] of rights.entries()) {
        const authority = event.authority;
        const current =
          authority &&
          sameTarget(authority.target, state.target) &&
          authority.actor.deviceId === approvedBy.deviceId &&
          authority.actor.principalId === approvedBy.principalId &&
          authority.inheritable.find((r) => r.permission === right.permission);
        if (!current)
          return { kind: "rejected", reason: "cancelled", state: { ...state, kind: "cancelled" } };
        const id = event.grantIds[i];
        if (!id) return reject("invalidProof");
        grants.push({
          id,
          principalId: event.principalId,
          target: state.target,
          permission: right.permission,
          inheritance: "children",
          modeCeiling:
            rank[current.ceiling] < rank[right.ceiling] ? current.ceiling : right.ceiling,
          grantedBy: approvedBy,
        });
      }
      const completed: Completed = {
        kind: "pairing.completed",
        requestId: x.requestId,
        principal: {
          kind: "device",
          id: event.principalId,
          ownerId: state.selection.ownerId,
          deviceId: x.deviceId,
        },
        deviceKey: {
          id: x.deviceKeyId,
          deviceId: x.deviceId,
          publicKey: x.publicKey,
          state: { kind: "usable", expiresAt: now + PAIRING_LIMITS.deviceKeyMs },
        },
        permissions: grants.map((g) => g.permission),
      };
      return {
        kind: "ok",
        state: {
          ...state,
          kind: "consumed",
          consumedChallengeId: x.challengeId,
          completed,
          grants,
        },
        completed,
      };
    }
  }
}

/** Offered only by the protected host after local OS identity and presence checks. Never a remote business method. */
export interface TrustedHostPairing {
  confirm(input: {
    kind: "bootstrap" | "recover";
    environment: EnvironmentIdentity;
    deviceId: DeviceId;
    publicKey: DeviceKey["publicKey"];
  }): Promise<"registered" | "alreadyRegistered" | "denied">;
}

type ExchangeIntent = Omit<Extract<PairingEvent, { kind: "exchange" }>, "authority" | "currentKey">;
export interface PairingStore {
  read(id: PairingInviteId): Promise<PairingState | null>;
  create(invitation: Extract<PairingState, { kind: "open" }>): Promise<"created" | "alreadyExists">;
  /** Serialize the invitation with current key and delegable-grant reads. Commit its resulting state, key and grants before replying, including cancellation on loss of authority. */
  apply(
    id: PairingInviteId,
    event: Exclude<PairingEvent, { kind: "exchange" }> | ExchangeIntent,
    now: number,
  ): Promise<Result | null>;
}
