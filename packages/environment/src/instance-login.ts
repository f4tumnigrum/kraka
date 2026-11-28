import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  CommandIdSchema,
  ExecutorInstanceIdSchema,
  EnvironmentSessionIdSchema,
  ObjectVersionSchema,
  CredentialBindingSchema,
  LoginPhaseSchema,
  type CommandId,
  type InstanceLoginResult,
  type LoginInteraction,
} from "@kraka/protocol";
import type {
  AuthenticationResult,
  CredentialBinding,
  ExecutorRegistration,
  LoginFlow,
} from "./executor-records";

const recordSchema = v.strictObject({
  flowId: CommandIdSchema,
  instanceId: ExecutorInstanceIdSchema,
  ownerSessionId: EnvironmentSessionIdSchema,
  configVersion: ObjectVersionSchema,
  credential: v.nullable(CredentialBindingSchema),
  expectedAccount: v.string(),
  interaction: v.picklist(["browser", "deviceCode", "nativeCli"]),
  verifyingAt: v.nullable(v.number()),
  expiresAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  needsAccountCheck: v.boolean(),
  nativeLoginId: v.nullable(v.string()),
  phase: LoginPhaseSchema,
  reason: v.nullable(v.string()),
});
type Record = v.InferOutput<typeof recordSchema>;
type Event =
  | { kind: "started"; nativeLoginId: string; expiresAt: number; interaction: LoginInteraction }
  | { kind: "callback"; nativeLoginId: string; success: boolean }
  | { kind: "probe"; authentication: AuthenticationResult }
  | { kind: "cancel" | "check" }
  | {
      kind: "failed";
      reason: "Login unavailable" | "Login connection closed" | "Session authorization ended";
    };
type Advance = Pick<LoginFlow, "flowId" | "ownerSessionId" | "instanceId" | "configVersion"> & {
  expectedCredential: CredentialBinding | null;
  now: number;
  event: Event;
};
export const loginTable =
  "CREATE TABLE IF NOT EXISTS instance_logins(flow TEXT PRIMARY KEY,instance TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS logins_by_instance ON instance_logins(instance)";
const live = (r: Record) =>
  ["starting", "browser", "deviceCode", "nativeCli", "verifying"].includes(r.phase);

export class InstanceLogins {
  private readonly interactions = new Map<CommandId, LoginInteraction>();
  constructor(
    private readonly db: Database,
    private readonly registration: (id: LoginFlow["instanceId"]) => ExecutorRegistration | null,
  ) {}
  load(flow: CommandId) {
    const row = this.db
      .query<{ data: string }, [string]>("SELECT data FROM instance_logins WHERE flow=?")
      .get(flow);
    return row ? v.parse(recordSchema, JSON.parse(row.data)) : null;
  }
  private save(r: Record) {
    this.db.run(
      "INSERT INTO instance_logins(flow,instance,data) VALUES(?,?,?) ON CONFLICT(flow) DO UPDATE SET data=excluded.data",
      [r.flowId, r.instanceId, JSON.stringify(r)],
    );
    if (!["browser", "deviceCode", "nativeCli"].includes(r.phase))
      this.interactions.delete(r.flowId);
  }
  private current(r: LoginFlow) {
    const reg = this.registration(r.instanceId);
    return (
      reg?.enabled &&
      reg.version === r.configVersion &&
      Bun.deepEquals(reg.credential, r.credential)
    );
  }
  recover() {
    const rows = this.db
      .query<{ data: string }, []>(
        "SELECT data FROM instance_logins WHERE json_extract(data,'$.phase') IN ('starting','browser','deviceCode','nativeCli','verifying')",
      )
      .all();
    return this.db.transaction(() =>
      rows.map(({ data }) => {
        const r = v.parse(recordSchema, JSON.parse(data));
        this.save({ ...r, needsAccountCheck: true, phase: "failed", reason: "Daemon restarted" });
        return r;
      }),
    )();
  }
  pendingAccountChecks() {
    return this.db
      .query<{ data: string }, []>(
        "SELECT data FROM instance_logins WHERE json_extract(data,'$.needsAccountCheck')=1",
      )
      .all()
      .map(({ data }) => v.parse(recordSchema, JSON.parse(data)));
  }
  accountChecked(flowId: CommandId) {
    const record = this.load(flowId);
    if (record?.needsAccountCheck) this.save({ ...record, needsAccountCheck: false });
  }
  begin(input: Omit<LoginFlow, "expiresAt">, now: number) {
    const flow: LoginFlow = { ...input, expiresAt: now + 600_000 };
    return this.db.transaction(() => {
      const prior = this.load(flow.flowId);
      if (prior)
        return prior.instanceId === flow.instanceId &&
          prior.ownerSessionId === flow.ownerSessionId &&
          prior.expectedAccount === flow.expectedAccount &&
          prior.interaction === flow.interaction
          ? ({ kind: "existing", flow: prior } as const)
          : ({ kind: "conflict" } as const);
      if (!this.current(flow)) return { kind: "conflict" } as const;
      const rows = this.db
        .query<{ data: string }, [string]>(
          "SELECT data FROM instance_logins WHERE instance=? AND json_extract(data,'$.phase') IN ('starting','browser','deviceCode','nativeCli','verifying')",
        )
        .all(flow.instanceId);
      for (const { data } of rows) {
        const old = v.parse(recordSchema, JSON.parse(data));
        const settled = this.advanceLogin({
          ...old,
          expectedCredential: old.credential,
          now,
          event: { kind: "check" },
        });
        if (settled && live(settled.record)) return { kind: "conflict" } as const;
      }
      this.save({
        ...flow,
        nativeLoginId: null,
        verifyingAt: null,
        needsAccountCheck: false,
        phase: "starting",
        reason: null,
      });
      return { kind: "created", flow } as const;
    })();
  }
  advanceLogin(input: Advance) {
    const r = this.load(input.flowId);
    if (
      !r ||
      r.ownerSessionId !== input.ownerSessionId ||
      r.instanceId !== input.instanceId ||
      r.configVersion !== input.configVersion ||
      !Bun.deepEquals(r.credential, input.expectedCredential)
    )
      return null;
    if (!live(r)) return { record: r, applied: false };
    const event = input.event;
    const next = { ...r };
    let applied = true;
    if (!this.current(r)) {
      applied = false;
      next.phase = "failed";
      next.reason = "Instance configuration changed";
    } else if (input.now >= r.expiresAt) {
      next.phase = "expired";
      applied = event.kind === "check";
    } else
      switch (event.kind) {
        case "cancel":
          next.phase = "cancelled";
          break;
        case "check":
          return { record: r, applied: false };
        case "failed":
          next.phase = "failed";
          next.reason = event.reason;
          break;
        case "started":
          if (r.phase !== "starting") return { record: r, applied: false };
          next.nativeLoginId = event.nativeLoginId;
          next.expiresAt = event.expiresAt;
          next.phase = input.now >= event.expiresAt ? "expired" : event.interaction.kind;
          break;
        case "callback":
          if (
            r.nativeLoginId !== event.nativeLoginId ||
            !["browser", "deviceCode", "nativeCli"].includes(r.phase)
          )
            return { record: r, applied: false };
          next.verifyingAt = event.success ? input.now : null;
          next.phase = event.success ? "verifying" : "failed";
          next.reason = event.success ? null : "Provider rejected login";
          break;
        case "probe":
          if (r.phase !== "verifying") return { record: r, applied: false };
          if (
            event.authentication.status.state === "yes" &&
            event.authentication.status.verifiedAt !== null &&
            r.verifyingAt !== null &&
            event.authentication.status.verifiedAt >= r.verifyingAt &&
            event.authentication.status.verifiedAt <= input.now &&
            event.authentication.account === r.expectedAccount
          )
            next.phase = "authenticated";
          else {
            next.phase = "failed";
            next.reason =
              event.authentication.status.state === "unknown"
                ? "Account probe inconclusive"
                : event.authentication.status.state === "no"
                  ? "Signed out"
                  : "Unexpected account";
          }
          break;
      }
    if (next.phase === "cancelled" || next.phase === "expired" || next.phase === "failed")
      next.needsAccountCheck = true;
    this.save(next);
    if (event.kind === "started" && next.phase === event.interaction.kind)
      this.interactions.set(r.flowId, event.interaction);
    return { record: next, applied };
  }
  read(
    flowId: CommandId,
    instanceId: LoginFlow["instanceId"],
    session: LoginFlow["ownerSessionId"],
    now: number,
  ): InstanceLoginResult | null {
    const r = this.load(flowId);
    if (!r || r.instanceId !== instanceId) return null;
    const updated =
      this.advanceLogin({ ...r, expectedCredential: r.credential, now, event: { kind: "check" } })
        ?.record ?? r;
    return {
      kind: "instanceLogin",
      flowId,
      instanceId,
      expiresAt: updated.expiresAt,
      phase: updated.phase,
      reason: updated.reason,
      interaction: r.ownerSessionId === session ? (this.interactions.get(flowId) ?? null) : null,
    };
  }
}
