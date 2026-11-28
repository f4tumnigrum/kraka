import * as v from "valibot";
import {
  AdapterFamilySchema,
  AttemptIdSchema,
  CheckoutResultSchema,
  EXECUTOR_TOOL_METHODS,
  ExecutorInstanceIdSchema,
  ExecutorKeyIdSchema,
  NativeSessionIdSchema,
  PrincipalIdSchema,
  P256PublicKeySchema,
  ThreadIdSchema,
  canonicalJson,
  hasMethodPermissions,
  withinPrincipalCeiling,
  type CommandReceipt,
  type EnvironmentId,
  type ExecutorPrincipal,
  type ObjectVersion,
  type PermissionItem,
  type RequestMethodDefinition,
  type RoundId,
  type SignedRequest,
  type Thread,
  type ThreadId,
} from "@kraka/protocol";
import { readReceipt, readRound, readThread, type FirstSendStore } from "./first-send-store";
import type { ThreadBindingStore, ThreadSessionBinding } from "./executor-records";

const bindingSchema = v.strictObject({
  family: AdapterFamilySchema,
  instanceId: ExecutorInstanceIdSchema,
  nativeSessionId: NativeSessionIdSchema,
  epoch: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  threadId: ThreadIdSchema,
  attemptId: AttemptIdSchema,
});
type BoundSession = v.InferOutput<typeof bindingSchema>;
type ToolName = keyof typeof EXECUTOR_TOOL_METHODS;
export type ExecutorToolGrant = {
  readonly principal: ExecutorPrincipal;
  readonly environmentId: EnvironmentId;
  readonly keyId: v.InferOutput<typeof ExecutorKeyIdSchema>;
  readonly publicKey: v.InferOutput<typeof P256PublicKeySchema>;
  readonly binding: BoundSession;
  readonly roundId: RoundId;
  readonly instanceVersion: ObjectVersion;
  readonly methods: ReadonlySet<ToolName>;
};

export class ExecutorTools implements ThreadBindingStore {
  private readonly live = new Map<ThreadId, ExecutorToolGrant>();
  constructor(private readonly store: FirstSendStore) {}

  private latest(id: ThreadId) {
    const row = this.store.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM executor_tool_bindings WHERE thread=? ORDER BY epoch DESC LIMIT 1",
      )
      .get(id);
    return row ? v.parse(bindingSchema, JSON.parse(row.data)) : null;
  }

  async current(id: ThreadId) {
    return this.latest(id);
  }
  async history(id: ThreadId) {
    return this.store.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM executor_tool_bindings WHERE thread=? ORDER BY epoch",
      )
      .all(id)
      .map((row) => v.parse(bindingSchema, JSON.parse(row.data)));
  }

  async replace(expected: ThreadSessionBinding | null, next: ThreadSessionBinding) {
    if (!v.is(bindingSchema, next) || next.epoch !== (expected?.epoch ?? 0) + 1) return false;
    return this.store.db
      .transaction(() => {
        if (!Bun.deepEquals(this.latest(next.threadId), expected)) return false;
        this.live.delete(next.threadId);
        this.store.db.run("INSERT INTO executor_tool_bindings(thread,epoch,data) VALUES(?,?,?)", [
          next.threadId,
          next.epoch,
          JSON.stringify(next),
        ]);
        return true;
      })
      .immediate();
  }

  register({
    binding,
    roundId,
    instanceVersion,
    publicKey,
    methods,
  }: {
    binding: ThreadSessionBinding;
    roundId: RoundId;
    instanceVersion: ObjectVersion;
    publicKey: ExecutorToolGrant["publicKey"];
    methods: readonly ToolName[];
  }) {
    if (!v.is(bindingSchema, binding) || this.live.has(binding.threadId)) return null;
    const { db } = this.store;
    const grant = db
      .transaction(() => {
        if (!Bun.deepEquals(this.latest(binding.threadId), binding)) return null;
        const previous = db
          .query<{ principal: string }, [string, string]>(
            "SELECT principal FROM executor_tool_bindings WHERE thread=? AND json_extract(data,'$.attemptId')=? AND principal IS NOT NULL ORDER BY epoch DESC LIMIT 1",
          )
          .get(binding.threadId, binding.attemptId);
        const grant: ExecutorToolGrant = {
          principal: {
            kind: "executor",
            id: v.parse(PrincipalIdSchema, previous?.principal ?? crypto.randomUUID()),
            executorInstanceId: binding.instanceId,
            threadId: binding.threadId,
            attemptId: binding.attemptId,
          },
          keyId: v.parse(ExecutorKeyIdSchema, crypto.randomUUID()),
          environmentId: this.store.writer.environmentId,
          binding: { ...binding },
          roundId,
          instanceVersion,
          publicKey,
          methods: new Set(methods),
        };
        if (!this.attemptMatches(grant)) return null;
        const write = db
          .query(
            "UPDATE executor_tool_bindings SET principal=? WHERE thread=? AND epoch=? AND principal IS NULL",
          )
          .run(grant.principal.id, binding.threadId, binding.epoch);
        return write.changes ? grant : null;
      })
      .immediate();
    if (grant) this.live.set(binding.threadId, grant);
    return grant;
  }

  revoke(grant: ExecutorToolGrant) {
    if (this.live.get(grant.binding.threadId) === grant) this.live.delete(grant.binding.threadId);
  }

  isCurrent(grant: ExecutorToolGrant) {
    return (
      this.live.get(grant.binding.threadId) === grant &&
      Bun.deepEquals(this.latest(grant.binding.threadId), grant.binding) &&
      this.attemptMatches(grant)
    );
  }

  private attemptMatches(grant: ExecutorToolGrant) {
    const round = readRound(this.store.db, grant.roundId);
    if (
      !round ||
      round.threadId !== grant.binding.threadId ||
      round.attempt.attemptId !== grant.binding.attemptId
    )
      return false;
    const phase = round.attempt.phase;
    if (
      !(phase.kind === "filed" && phase.gate === "eligible") &&
      phase.kind !== "armed" &&
      phase.kind !== "handed" &&
      phase.kind !== "received" &&
      phase.kind !== "working"
    )
      return false;
    return !!this.store.db
      .query(
        `SELECT 1 FROM round_executors choice JOIN executor_registrations reg ON reg.id=choice.instance
       WHERE choice.round=? AND choice.instance=? AND choice.version=?
         AND json_extract(reg.data,'$.version')=choice.version AND json_extract(reg.data,'$.family')=?
         AND json_extract(reg.data,'$.enabled')=1`,
      )
      .get(round.id, grant.binding.instanceId, grant.instanceVersion, grant.binding.family);
  }
}

function otherDirectoryUser(store: FirstSendStore, thread: Thread) {
  if (!thread.directory) return false;
  return !!store.db
    .query(
      `SELECT 1 FROM threads WHERE id<>? AND json_extract(data,'$.projectId')=?
      AND json_extract(data,'$.directory.directoryId')=? AND json_extract(data,'$.directory.generation')=?
      AND json_extract(data,'$.lifecycle.archivedAt') IS NULL
      AND coalesce(json_extract(data,'$.lifecycle.state.kind'),'active')='active' LIMIT 1`,
    )
    .get(thread.id, thread.projectId, thread.directory.directoryId, thread.directory.generation);
}

/** The connection verifies the signature and sequence before passing its bound grant to the writer. */
export function invokeExecutorTool({
  request,
  grant,
  transaction: store,
  allows,
}: {
  request: SignedRequest;
  grant: ExecutorToolGrant;
  transaction: FirstSendStore;
  allows: (thread: ThreadId, permission: PermissionItem) => boolean;
}): CommandReceipt {
  const commandId = request.commandId;
  const refuse = (
    kind: "notFound" | "expired" | "invalidProof" | "idConflict" | "unsupported",
  ): CommandReceipt => ({ kind: "rejected", commandId, failure: { kind } });
  return store.db
    .transaction((): CommandReceipt => {
      if (
        request.environmentId !== grant.environmentId ||
        request.signer.kind !== "executor" ||
        request.signer.keyId !== grant.keyId ||
        request.signer.principalId !== grant.principal.id
      )
        return refuse("invalidProof");
      if (!store.services.executorTools.isCurrent(grant)) return refuse("expired");
      const tool = [...grant.methods].find(
        (name) => EXECUTOR_TOOL_METHODS[name].method === request.method,
      );
      if (!tool) return refuse("unsupported");
      const operation: RequestMethodDefinition = EXECUTOR_TOOL_METHODS[tool];
      const target =
        request.method === "attachment.upload"
          ? request.payload.target
          : "threadId" in request.payload
            ? { kind: "thread" as const, threadId: request.payload.threadId }
            : null;
      if (target?.kind !== "thread" || target.threadId !== grant.principal.threadId)
        return refuse("notFound");
      const rights = [operation.permission, ...(operation.additionalPermissions ?? [])];
      const allowed = new Set(
        rights.filter(
          (right) =>
            withinPrincipalCeiling(grant.principal, target, right) &&
            allows(target.threadId, right),
        ),
      );
      if (!hasMethodPermissions(operation, allowed)) {
        const missing = rights.find((right) => !allowed.has(right)) ?? operation.permission;
        return {
          kind: "rejected",
          commandId,
          failure: { kind: "missingPermission", target, permission: missing },
        };
      }
      if (request.method !== "thread.inspectCheckout") return refuse("unsupported");
      const thread = readThread(store.db, target.threadId);
      if (!thread) return refuse("notFound");
      const intent = canonicalJson({
        method: request.method,
        target,
        attemptId: grant.principal.attemptId,
        payload: request.payload,
      });
      const prior = readReceipt(store.db, grant.principal.id, commandId);
      if (prior && prior.intent !== intent) return refuse("idConflict");
      const path = store.directory(thread);
      if (prior) {
        const original = prior.receipt;
        if (original.kind !== "accepted" || original.result.kind !== "checkoutObserved")
          return refuse("idConflict");
        const checkout = original.result.checkout;
        if (
          checkout.kind === "unavailable" ||
          (path === checkout.path && Bun.deepEquals(checkout.binding, thread.directory))
        )
          return original;
        return {
          kind: "accepted",
          commandId,
          result: {
            kind: "checkoutObserved",
            checkout: { kind: "unavailable", reason: "Original checkout is no longer available" },
          },
        };
      }
      const checkout = v.parse(
        CheckoutResultSchema,
        path && thread.directory
          ? {
              kind: "available",
              binding: thread.directory,
              path,
              shared: otherDirectoryUser(store, thread),
            }
          : { kind: "unavailable", reason: "Directory binding is unavailable" },
      );
      const receipt: CommandReceipt = {
        kind: "accepted",
        commandId,
        result: { kind: "checkoutObserved", checkout },
      };
      store.db.run("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)", [
        grant.principal.id,
        commandId,
        intent,
        JSON.stringify(receipt),
      ]);
      return receipt;
    })
    .immediate();
}
