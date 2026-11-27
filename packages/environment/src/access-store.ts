import type { Database } from "bun:sqlite";
import { randomInt } from "node:crypto";
import * as v from "valibot";
import {
  DeviceKeyIdSchema,
  AccessChangeSchema,
  AccessGrantIdSchema,
  CommandIdSchema,
  CommandReceiptSchema,
  DEFAULT_DEVICE_PERMISSIONS,
  DeviceKeySchema,
  DevicePrincipalSchema,
  PairingClaimIdSchema,
  PairingInviteIdSchema,
  PermissionGrantSchema,
  PrincipalIdSchema,
  PAIRING_LIMITS,
  canonicalJson,
  type AccessGrantId,
  type AuthorizationTarget,
  type CommandId,
  type CommandReceipt,
  type DeviceKey,
  type DeviceId,
  type DeviceKeyId,
  type EnvironmentIdentity,
  type PairingInviteId,
  type PairingRequest,
  type PairingRequestId,
  type PermissionGrant,
  type PermissionItem,
  type PermissionMode,
  type PrincipalId,
  type ProjectId,
  type ThreadId,
  type RequestResult,
  type SessionAuthorized,
  type SignedRequest,
} from "@kraka/protocol";
import {
  createPairingInvite,
  transitionPairing,
  type PairingEvent,
  type PairingState,
  type PairingStore,
  type TrustedHostPairing,
} from "./pairing";

type Principal = v.InferOutput<typeof DevicePrincipalSchema>;
export type DeviceActor = { principal: Principal; deviceKey: DeviceKey };
type Target = AuthorizationTarget;
type Change = v.InferOutput<typeof AccessChangeSchema>;
type GrantActor = Extract<PermissionGrant["grantedBy"], { kind: "device" }>;
type HostInput = Parameters<TrustedHostPairing["confirm"]>[0];
export type UpgradeInput = {
  environmentId: EnvironmentIdentity["id"];
  deviceId: DeviceId;
  keyId: DeviceKeyId;
  commandId: CommandId;
};
type Decision = (detail: {
  operation: "bootstrap" | "recover" | "environment.upgrade";
  environment: EnvironmentIdentity;
  deviceId: DeviceId;
  keyId: DeviceKeyId;
  publicKey: string;
}) => Promise<boolean>;
export interface HostDecision {
  present(): Promise<boolean>;
  approve: Decision;
}
type StoredInvite = { body: string };
const uuid = <T extends v.GenericSchema>(schema: T) => v.parse(schema, crypto.randomUUID());
const rank = { ask: 0, edits: 1, open: 2 };
const sameTarget = (a: Target, b: Target) => canonicalJson(a) === canonicalJson(b);
const issuer = (p: Principal): GrantActor => ({
  kind: "device",
  deviceId: p.deviceId,
  principalId: p.id,
});
type Failure = Extract<CommandReceipt, { kind: "rejected" }>["failure"];
class Rejected extends Error {
  constructor(readonly failure: Failure) {
    super(failure.kind);
  }
}
function refuse(
  kind: "notFound" | "idConflict" | "invalidState" | "cursorExpired" | "unsupported",
): never {
  throw new Rejected({ kind });
}
export type AccessNotification =
  | { kind: "selected"; inviteId: PairingInviteId }
  | { kind: "revoked"; deviceId: DeviceId; keyId: DeviceKeyId }
  | { kind: "grantsChanged" };
type LiveAccess = {
  sessions: () => SessionAuthorized[];
  notify: (event: AccessNotification) => void;
};
const offline: LiveAccess = { sessions: () => [], notify() {} };

export class AccessStore implements PairingStore {
  readonly target: Extract<Target, { kind: "environment" }>;
  private readonly pages = new Map<string, { scope: string; offset: number }>();
  live: LiveAccess = offline;
  constructor(
    readonly db: Database,
    readonly identity: EnvironmentIdentity,
    readonly now = Date.now,
  ) {
    this.target = { kind: "environment", environmentId: identity.id };
    db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS devices(device TEXT PRIMARY KEY,key TEXT NOT NULL UNIQUE,principal TEXT NOT NULL UNIQUE,person TEXT NOT NULL,key_data TEXT NOT NULL,first_owner INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY,body TEXT NOT NULL,permissions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS applications(id TEXT PRIMARY KEY,invite TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,parent TEXT,PRIMARY KEY(kind,id));
      CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY, principal TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS changes(body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,principal TEXT NOT NULL,intent TEXT NOT NULL,body TEXT NOT NULL);`);
  }
  provisionProject(project: ProjectId) {
    this.db.run("INSERT OR IGNORE INTO objects VALUES('project',?,NULL)", [project]);
  }
  provisionThread(thread: ThreadId, project: ProjectId) {
    this.lineage({ kind: "project", projectId: project });
    this.db.run("INSERT INTO objects VALUES('thread',?,?)", [thread, project]);
  }
  ensureThread(thread: ThreadId, project: ProjectId) {
    const parent = this.db.query<{ parent: string }, [string]>(
      "SELECT parent FROM objects WHERE kind='thread' AND id=?",
    );
    const known = parent.get(thread);
    if (known) return known.parent === project;
    return this.db
      .transaction(() => {
        const concurrent = parent.get(thread);
        if (concurrent) return concurrent.parent === project;
        this.provisionProject(project);
        this.provisionThread(thread, project);
        return true;
      })
      .immediate();
  }
  private lineage(target: Target): Target[] {
    if (target.kind === "environment") {
      if (!sameTarget(target, this.target)) refuse("notFound");
      return [this.target];
    }
    const project =
      target.kind === "project"
        ? target.projectId
        : this.db
            .query<{ parent: ProjectId }, [string]>(
              "SELECT parent FROM objects WHERE kind='thread' AND id=?",
            )
            .get(target.threadId)?.parent;
    if (
      !project ||
      !this.db.query("SELECT 1 FROM objects WHERE kind='project' AND id=?").get(project)
    )
      refuse("notFound");
    return target.kind === "project"
      ? [target, this.target]
      : [target, { kind: "project", projectId: project }, this.target];
  }
  device(id: DeviceId): DeviceActor | null {
    const row = this.db
      .query<{ person: string; key_data: string }, [string]>(
        "SELECT person,key_data FROM devices WHERE device=?",
      )
      .get(id);
    return row
      ? {
          principal: v.parse(DevicePrincipalSchema, JSON.parse(row.person)),
          deviceKey: v.parse(DeviceKeySchema, JSON.parse(row.key_data)),
        }
      : null;
  }
  private usable(actor: DeviceActor | null, key?: DeviceKeyId): actor is DeviceActor {
    return (
      !!actor &&
      (!key || actor.deviceKey.id === key) &&
      actor.deviceKey.state.kind === "usable" &&
      this.now() < actor.deviceKey.state.expiresAt
    );
  }
  private grants(principal?: PrincipalId) {
    const rows = principal
      ? this.db
          .query<StoredInvite, [string]>("SELECT body FROM grants WHERE principal=? ORDER BY rowid")
          .all(principal)
      : this.db.query<StoredInvite, []>("SELECT body FROM grants ORDER BY rowid").all();
    return rows.map((r) => v.parse(PermissionGrantSchema, JSON.parse(r.body)));
  }
  ceiling(
    principal: PrincipalId,
    target: Target,
    permission: PermissionItem,
    children = false,
  ): PermissionMode | null {
    const chain = this.lineage(target);
    let best: PermissionMode | null = null;
    for (const g of this.grants(principal)) {
      if (
        g.permission !== permission ||
        !chain.some((t) => sameTarget(t, g.target)) ||
        (g.inheritance !== "children" && (children || !sameTarget(g.target, target)))
      )
        continue;
      if (best === null || rank[g.modeCeiling] > rank[best]) best = g.modeCeiling;
    }
    return best;
  }
  private require(
    principal: PrincipalId,
    target: Target,
    permission: PermissionItem,
    children = false,
  ) {
    const ceiling = this.ceiling(principal, target, permission, children);
    if (!ceiling) throw new Rejected({ kind: "missingPermission", permission, target });
    return ceiling;
  }
  private change(
    commandId: CommandId,
    actorId: PrincipalId,
    target: Target,
    change: Change["change"],
  ) {
    this.db.run("INSERT INTO changes VALUES(?)", [
      JSON.stringify({ commandId, actorId, target, at: this.now(), change } satisfies Change),
    ]);
  }
  private grant(g: PermissionGrant, commandId: CommandId, actor: PrincipalId) {
    this.db.run("INSERT INTO grants VALUES(?,?,?)", [g.id, g.principalId, JSON.stringify(g)]);
    this.change(commandId, actor, g.target, { kind: "granted", grant: g });
  }
  private insertDevice(principal: Principal, key: DeviceKey, first: boolean) {
    this.db.run("INSERT INTO devices VALUES(?,?,?,?,?,?)", [
      principal.deviceId,
      key.id,
      principal.id,
      JSON.stringify(principal),
      JSON.stringify(key),
      Number(first),
    ]);
  }
  async confirm(
    request: HostInput,
    decision: HostDecision,
  ): Promise<"registered" | "alreadyRegistered" | "denied"> {
    const input = {
      ...request,
      keyId:
        request.keyId ?? this.device(request.deviceId)?.deviceKey.id ?? uuid(DeviceKeyIdSchema),
    };
    if (
      canonicalJson(input.environment) !== canonicalJson(this.identity) ||
      !(await decision.present()) ||
      !(await decision.approve({ ...input, operation: input.kind }))
    )
      return "denied";
    try {
      const point = Buffer.from(input.publicKey, "base64url");
      if (point.length !== 65 || point[0] !== 4 || point.toString("base64url") !== input.publicKey)
        return "denied";
      await crypto.subtle.importKey("raw", point, { name: "ECDSA", namedCurve: "P-256" }, false, [
        "verify",
      ]);
    } catch {
      return "denied";
    }
    return this.db
      .transaction(() => {
        const existing = this.device(input.deviceId);
        if (existing)
          return this.usable(existing, input.keyId) &&
            existing.deviceKey.publicKey === input.publicKey &&
            this.isOwner(input.deviceId)
            ? ("alreadyRegistered" as const)
            : ("denied" as const);
        const owners = this.db
          .query<{ device: DeviceId }, []>(
            "SELECT device FROM devices WHERE first_owner=1 ORDER BY rowid",
          )
          .all();
        if (
          (input.kind === "bootstrap") !== !owners.length ||
          owners.some((o) => this.usable(this.device(o.device)))
        )
          return "denied" as const;
        if (this.db.query("SELECT 1 FROM devices WHERE key=?").get(input.keyId))
          return "denied" as const;
        const principalId = uuid(PrincipalIdSchema);
        const ownerId = owners[0]
          ? (this.device(owners[0].device) ?? refuse("invalidState")).principal.ownerId
          : principalId;
        const principal: Principal = {
          id: principalId,
          kind: "device",
          deviceId: input.deviceId,
          ownerId,
        };
        this.insertDevice(
          principal,
          {
            id: input.keyId,
            deviceId: input.deviceId,
            publicKey: input.publicKey,
            state: { kind: "usable", expiresAt: this.now() + PAIRING_LIMITS.deviceKeyMs },
          },
          true,
        );
        const command = uuid(CommandIdSchema);
        for (const permission of DEFAULT_DEVICE_PERMISSIONS)
          this.grant(
            {
              id: uuid(AccessGrantIdSchema),
              principalId,
              target: this.target,
              permission,
              inheritance: "children",
              modeCeiling: "open",
              grantedBy: issuer(principal),
            },
            command,
            ownerId,
          );
        return "registered" as const;
      })
      .immediate();
  }
  private isOwner(device: DeviceId) {
    return !!this.db.query("SELECT 1 FROM devices WHERE first_owner=1 AND device=?").get(device);
  }
  async grantOwnerUpgrade(
    input: UpgradeInput,
    decision: HostDecision,
  ): Promise<AccessGrantId | null> {
    const prior = this.device(input.deviceId);
    if (
      input.environmentId !== this.identity.id ||
      !this.usable(prior, input.keyId) ||
      !this.isOwner(input.deviceId) ||
      !(await decision.present()) ||
      !(await decision.approve({
        ...input,
        operation: "environment.upgrade",
        environment: this.identity,
        publicKey: prior.deviceKey.publicKey,
      }))
    )
      return null;
    return this.db
      .transaction(() => {
        const actor = this.device(input.deviceId);
        if (!this.isOwner(input.deviceId) || !this.usable(actor, input.keyId)) return null;
        const intent = canonicalJson({
          method: "host.grantOwnerUpgrade",
          environmentId: input.environmentId,
          deviceId: input.deviceId,
          keyId: input.keyId,
        });
        const old = this.receipt(input.commandId, actor.principal.id, intent);
        if (old?.kind === "accepted" && old.result.kind === "accessChanged")
          return old.result.grantId;
        const grantId = uuid(AccessGrantIdSchema);
        this.grant(
          {
            id: grantId,
            principalId: actor.principal.id,
            target: this.target,
            permission: "environment.upgrade",
            inheritance: "targetOnly",
            modeCeiling: "open",
            grantedBy: issuer(actor.principal),
          },
          input.commandId,
          actor.principal.ownerId,
        );
        this.save(actor.principal.id, intent, {
          kind: "accepted",
          commandId: input.commandId,
          result: { kind: "accessChanged", grantId },
        });
        return grantId;
      })
      .immediate();
  }
  private receipt(id: CommandId, principal: PrincipalId, intent: string) {
    const row = this.db
      .query<{ principal: string; intent: string; body: string }, [string]>(
        "SELECT principal,intent,body FROM receipts WHERE id=?",
      )
      .get(id);
    if (!row) return null;
    if (row.principal !== principal || row.intent !== intent) refuse("idConflict");
    return v.parse(CommandReceiptSchema, JSON.parse(row.body));
  }
  private save(principal: PrincipalId, intent: string, receipt: CommandReceipt) {
    this.db.run("INSERT INTO receipts VALUES(?,?,?,?)", [
      receipt.commandId,
      principal,
      intent,
      JSON.stringify(receipt),
    ]);
  }
  invitation(id: PairingInviteId): PairingState | null {
    const row = this.db
      .query<StoredInvite, [string]>("SELECT body FROM invites WHERE id=?")
      .get(id);
    return row ? JSON.parse(row.body) : null;
  }
  async read(id: PairingInviteId) {
    return this.invitation(id);
  }
  async create(invite: Extract<PairingState, { kind: "open" }>) {
    return this.insertInvite(invite) ? ("created" as const) : ("alreadyExists" as const);
  }
  private insertInvite(
    invite: Extract<PairingState, { kind: "open" }>,
    available: readonly PermissionItem[] = DEFAULT_DEVICE_PERMISSIONS,
  ) {
    return (
      this.db.run("INSERT OR IGNORE INTO invites VALUES(?,?,?)", [
        invite.inviteId,
        JSON.stringify(invite),
        JSON.stringify(available),
      ]).changes === 1
    );
  }
  private write(before: PairingState, event: PairingEvent, now: number) {
    const result = transitionPairing(before, event, now);
    if (result.state !== before)
      this.db.run("UPDATE invites SET body=? WHERE id=?", [
        JSON.stringify(result.state),
        before.inviteId,
      ]);
    if (event.kind === "apply" && result.kind === "ok" && result.state !== before)
      this.db.run("INSERT INTO applications VALUES(?,?)", [
        event.pending.requestId,
        before.inviteId,
      ]);
    if (result.state !== before && result.state.kind === "consumed") {
      const { completed, grants, selection } = result.state;
      this.insertDevice(completed.principal, completed.deviceKey, false);
      const cmd = uuid(CommandIdSchema);
      for (const grant of grants) this.grant(grant, cmd, selection.approvedBy.principalId);
    }
    return result;
  }
  async apply(id: PairingInviteId, event: Parameters<PairingStore["apply"]>[1], now: number) {
    return this.db
      .transaction(() => {
        const state = this.invitation(id);
        if (!state) return null;
        if (event.kind !== "exchange") return this.write(state, event, now);
        const { exchange } = event;
        const actor =
          state.kind === "selected" ? this.device(state.selection.approvedBy.deviceId) : null;
        const authority =
          state.kind === "selected" &&
          this.usable(actor) &&
          actor.principal.id === state.selection.approvedBy.principalId &&
          this.ceiling(actor.principal.id, state.target, "access.give")
            ? {
                actor: issuer(actor.principal),
                target: state.target,
                inheritable: state.selection.rights.flatMap((r) => {
                  const ceiling = this.ceiling(
                    actor.principal.id,
                    state.target,
                    r.permission,
                    true,
                  );
                  return ceiling ? [{ permission: r.permission, ceiling }] : [];
                }),
              }
            : null;
        const current = this.device(exchange.deviceId)?.deviceKey ?? null;
        const collision = this.db
          .query("SELECT 1 FROM devices WHERE key=?")
          .get(exchange.deviceKeyId);
        return this.write(
          state,
          {
            ...event,
            verified: event.verified && !(state.kind !== "consumed" && (current || collision)),
            authority,
            currentKey: current,
          },
          now,
        );
      })
      .immediate();
  }
  application(request: PairingRequest) {
    return this.db
      .transaction(() => {
        const state = this.invitation(request.inviteId);
        if (
          !state ||
          request.environmentId !== this.identity.id ||
          !sameTarget(request.target, state.target) ||
          request.requestedPermissions.some((p) => p === "environment.upgrade") ||
          new Set(request.requestedPermissions).size !== request.requestedPermissions.length
        )
          return "invalidProof" as const;
        const offer = this.db
          .query<{ permissions: string }, [string]>("SELECT permissions FROM invites WHERE id=?")
          .get(state.inviteId);
        if (!offer) return "invalidProof" as const;
        const allowed: PermissionItem[] = JSON.parse(offer.permissions);
        const matching = this.byRequest(request.requestId);
        if (matching && matching.inviteId !== state.inviteId) return "invalidProof" as const;
        const prior = state.applications.find((a) => a.requestId === request.requestId);
        if (
          prior &&
          (prior.deviceId !== request.deviceId ||
            prior.publicKey !== request.publicKey ||
            prior.permissions.length !== request.requestedPermissions.length ||
            !prior.permissions.every((p) => request.requestedPermissions.includes(p)))
        )
          return "invalidProof" as const;
        if (prior && state.kind === "consumed") return prior;
        if (
          !prior &&
          state.kind === "open" &&
          request.requestedPermissions.some((p) => !allowed.includes(p))
        )
          return "invalidProof" as const;
        let code = prior?.confirmationCode;
        while (!code) {
          const n = randomInt(1_000_000).toString().padStart(6, "0");
          if (!state.applications.some((a) => a.confirmationCode === n)) code = n;
        }
        const pending = prior ?? {
          kind: "pairing.pending" as const,
          environmentId: request.environmentId,
          inviteId: request.inviteId,
          requestId: request.requestId,
          deviceId: request.deviceId,
          publicKey: request.publicKey,
          target: state.target,
          permissions: [...request.requestedPermissions],
          confirmationCode: code,
        };
        const r = this.write(state, { kind: "apply", pending }, this.now());
        return r.kind === "ok" ? pending : r.reason;
      })
      .immediate();
  }
  private byRequest(id: PairingRequestId) {
    const row = this.db
      .query<{ invite: PairingInviteId }, [string]>("SELECT invite FROM applications WHERE id=?")
      .get(id);
    return row ? this.invitation(row.invite) : null;
  }
  private page<T>(rows: T[], scope: string, after: string | null) {
    const page = after ? this.pages.get(after) : { scope, offset: 0 };
    if (!page || page.scope !== scope) refuse("cursorExpired");
    const items = rows.slice(page.offset, page.offset + 8);
    const offset = page.offset + items.length;
    const next = offset < rows.length ? crypto.randomUUID() : null;
    if (next) {
      if (this.pages.size >= 4096) {
        const first = this.pages.keys().next();
        if (!first.done) this.pages.delete(first.value);
      }
      this.pages.set(next, { scope, offset });
    }
    return { items, next };
  }
  revokeDevice(input: {
    actor: DeviceActor;
    deviceId: DeviceId;
    deviceKeyId: DeviceKeyId;
    commandId: CommandId;
  }) {
    return this.command(input.actor, {
      method: "device.revoke",
      commandId: input.commandId,
      payload: { deviceId: input.deviceId, deviceKeyId: input.deviceKeyId },
    });
  }
  command(actor: DeviceActor, request: AccessCommand): CommandReceipt {
    const effects: AccessNotification[] = [];
    try {
      const receipt = this.db
        .transaction(() => {
          const current = this.device(actor.principal.deviceId);
          if (
            !this.usable(current, actor.deviceKey.id) ||
            current.principal.id !== actor.principal.id
          )
            refuse("invalidState");
          const principal = current.principal;
          const target = this.commandTarget(request);
          const read =
            request.method === "thread.readHistory" || request.method === "subscription.openThread";
          this.require(principal.id, target, read ? "thread.view" : "access.give");
          const intent = canonicalJson({
            method: request.method,
            payload: request.payload,
            target,
          });
          // Lists always re-read live authority and contents, even when an old command is retried.
          const query = request.method.includes(".list") || read;
          const old = this.receipt(request.commandId, principal.id, intent);
          if (old && !query) return old;
          const result = this.execute(principal, target, request, effects);
          const accepted = { kind: "accepted" as const, commandId: request.commandId, result };
          if (!old) this.save(principal.id, intent, accepted);
          return accepted;
        })
        .immediate();
      for (const e of effects) this.live.notify(e);
      return receipt;
    } catch (e) {
      if (e instanceof Rejected)
        return { kind: "rejected", commandId: request.commandId, failure: e.failure };
      throw e;
    }
  }
  private commandTarget(r: AccessCommand): Target {
    switch (r.method) {
      case "access.listGrants":
      case "access.listChanges":
      case "device.pairing.listInvites":
      case "device.pairing.listApplications":
      case "access.grant":
        return r.payload.target;
      case "device.pairing.invite":
        return { kind: "project", projectId: r.payload.projectId };
      case "device.pairing.cancel":
        return this.invitation(r.payload.inviteId)?.target ?? refuse("notFound");
      case "device.pairing.approve":
        return this.byRequest(r.payload.requestId)?.target ?? refuse("notFound");
      case "thread.readHistory":
      case "subscription.openThread":
        return { kind: "thread", threadId: r.payload.threadId };
      case "access.revoke": {
        const row = this.db
          .query<StoredInvite, [string]>("SELECT body FROM grants WHERE id=?")
          .get(r.payload.grantId);
        // The original target survives revocation in the grant history.
        const first = row
          ? null
          : this.db
              .query<StoredInvite, [string]>(
                "SELECT body FROM changes WHERE json_extract(body,'$.change.grant.id')=? LIMIT 1",
              )
              .get(r.payload.grantId);
        return row
          ? v.parse(PermissionGrantSchema, JSON.parse(row.body)).target
          : first
            ? v.parse(AccessChangeSchema, JSON.parse(first.body)).target
            : refuse("notFound");
      }
      case "device.revoke":
      case "access.listSessions":
        return this.target;
      default:
        return refuse("unsupported");
    }
  }
  private execute(
    principal: Principal,
    target: Target,
    r: AccessCommand,
    effects: AccessNotification[],
  ): RequestResult {
    const scope = canonicalJson([
      principal.id,
      r.method,
      target,
      "inviteId" in r.payload ? r.payload.inviteId : null,
    ]);
    switch (r.method) {
      case "access.listGrants": {
        const p = this.page(
          this.grants().filter((g) => sameTarget(g.target, target)),
          scope,
          r.payload.after,
        );
        return { kind: "grantsListed", grants: p.items, next: p.next };
      }
      case "access.listChanges": {
        const changes = this.db
          .query<StoredInvite, []>("SELECT body FROM changes ORDER BY rowid")
          .all()
          .map((row) => v.parse(AccessChangeSchema, JSON.parse(row.body)));
        const p = this.page(
          changes.filter((g) => sameTarget(g.target, target)),
          scope,
          r.payload.after,
        );
        return { kind: "accessChangesListed", changes: p.items, next: p.next };
      }
      case "device.pairing.listInvites": {
        const rows = this.db
          .query<{ id: PairingInviteId }, []>("SELECT id FROM invites ORDER BY rowid")
          .all()
          .flatMap((row) => {
            const s = this.invitation(row.id);
            return s &&
              sameTarget(s.target, target) &&
              (s.kind === "open" || s.kind === "selected") &&
              this.now() < s.expiresAt
              ? [{ inviteId: s.inviteId, target, expiresAt: s.expiresAt, kind: s.kind }]
              : [];
          });
        const p = this.page(rows, scope, r.payload.after);
        return { kind: "invitesListed", invites: p.items, next: p.next };
      }
      case "device.pairing.listApplications": {
        const s = this.invitation(r.payload.inviteId);
        if (!s || !sameTarget(s.target, target)) refuse("notFound");
        const p = this.page([...s.applications], scope, r.payload.after);
        return { kind: "applicationsListed", applications: p.items, next: p.next };
      }
      case "device.pairing.invite": {
        const invite = createPairingInvite(
          this.identity.id,
          uuid(PairingInviteIdSchema),
          target,
          this.now(),
        );
        const available = DEFAULT_DEVICE_PERMISSIONS.filter((p) =>
          this.ceiling(principal.id, target, p, true),
        );
        if (!available.length || !this.insertInvite(invite, available)) refuse("idConflict");
        return { kind: "pairingInvited", inviteId: invite.inviteId, expiresAt: invite.expiresAt };
      }
      case "device.pairing.approve": {
        const state = this.byRequest(r.payload.requestId) ?? refuse("notFound");
        const rights = r.payload.permissions.map((permission) => ({
          permission,
          ceiling: this.require(principal.id, target, permission, true),
        }));
        const result = this.write(
          state,
          {
            kind: "approve",
            selection: {
              ownerId: principal.ownerId,
              approvedBy: issuer(principal),
              rights,
              claimId: uuid(PairingClaimIdSchema),
              requestId: r.payload.requestId,
            },
            confirmationCode: r.payload.confirmationCode,
          },
          this.now(),
        );
        if (result.kind !== "ok") refuse("invalidState");
        effects.push({ kind: "selected", inviteId: state.inviteId });
        return { kind: "actionAccepted" };
      }
      case "device.pairing.cancel": {
        const state = this.invitation(r.payload.inviteId) ?? refuse("notFound");
        if (this.write(state, { kind: "cancel" }, this.now()).kind !== "ok") refuse("invalidState");
        return { kind: "inviteCancelled", inviteId: state.inviteId };
      }
      case "access.listSessions":
        return {
          kind: "sessionsListed",
          sessions: this.live
            .sessions()
            .map(
              ({
                environmentSessionId: sessionId,
                connectionId,
                principal,
                signer,
                authorizedAt,
              }) => ({ sessionId, connectionId, principal, signer, authorizedAt }),
            ),
        };
      case "device.revoke": {
        const device = this.device(r.payload.deviceId);
        if (!device || device.deviceKey.id !== r.payload.deviceKeyId) refuse("notFound");
        if (device.deviceKey.state.kind === "usable") {
          this.db.run("UPDATE devices SET key_data=? WHERE device=?", [
            JSON.stringify({
              ...device.deviceKey,
              state: { kind: "revoked", revokedAt: this.now() },
            }),
            device.principal.deviceId,
          ]);
          for (const g of this.grants(device.principal.id))
            this.removeGrant(g, r.commandId, principal.id);
        }
        effects.push({
          kind: "revoked",
          deviceId: r.payload.deviceId,
          keyId: r.payload.deviceKeyId,
        });
        return { kind: "actionAccepted" };
      }
      case "access.revoke": {
        const g = this.grants().find((g) => g.id === r.payload.grantId) ?? refuse("notFound");
        this.removeGrant(g, r.commandId, principal.id);
        effects.push({ kind: "grantsChanged" });
        return { kind: "accessChanged", grantId: g.id };
      }
      case "access.grant": {
        const p = r.payload;
        if (!this.db.query("SELECT 1 FROM devices WHERE principal=?").get(p.principalId))
          refuse("notFound");
        const ceiling = this.require(
          principal.id,
          target,
          p.permission,
          p.inheritance === "children",
        );
        if (
          rank[ceiling] < rank[p.modeCeiling] ||
          (p.permission === "environment.upgrade" &&
            (target.kind !== "environment" || p.inheritance !== "targetOnly"))
        )
          refuse("invalidState");
        const id = uuid(AccessGrantIdSchema);
        this.grant({ ...p, id, grantedBy: issuer(principal) }, r.commandId, principal.id);
        return { kind: "accessChanged", grantId: id };
      }
      case "subscription.openThread":
        return {
          kind: "subscriptionOpened",
          subscriptionId: r.payload.subscriptionId,
          streamId: r.payload.streamId,
        };
      default:
        return refuse("unsupported");
    }
  }
  private removeGrant(g: PermissionGrant, c: CommandId, actor: PrincipalId) {
    this.db.run("DELETE FROM grants WHERE id=?", [g.id]);
    this.change(c, actor, g.target, { kind: "revoked", grantId: g.id });
  }
}
type CommandFields<T> = T extends SignedRequest
  ? Pick<T, "commandId" | "method" | "payload">
  : never;
type AccessCommand = CommandFields<SignedRequest>;
