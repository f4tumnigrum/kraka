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
  REQUEST_METHODS,
  type RequestResult,
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
import { savedBinding } from "./executor-bindings";
import { applyInputCommand } from "./input-command";
import { acceptTodoReply } from "./todo-command";
import { commandIntent, type LocalActor } from "./command-receipts";
import type { ThreadBindingStore, ThreadSessionBinding } from "./executor-records";

const bindingSchema = v.object({
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

export class ExecutorTools implements Pick<ThreadBindingStore, "current"> {
  private readonly live = new Map<ThreadId, ExecutorToolGrant>();
  constructor(private readonly store: FirstSendStore) {}

  async current(id: ThreadId) {
    return savedBinding(this.store, id);
  }

  private matchingBinding(binding: BoundSession) {
    const current = savedBinding(this.store, binding.threadId);
    return (
      current &&
      current.attemptId === binding.attemptId &&
      current.instanceId === binding.instanceId &&
      current.family === binding.family &&
      current.nativeSessionId === binding.nativeSessionId &&
      current.epoch === binding.epoch
    );
  }

  lookup(signer: SignedRequest["signer"]) {
    if (signer.kind === "executor")
      for (const grant of this.live.values()) {
        if (signer.keyId === grant.keyId && signer.principalId === grant.principal.id) return grant;
      }
    return null;
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
    if (!v.is(bindingSchema, binding)) return null;
    const { db } = this.store;
    const grant = db
      .transaction(() => {
        if (!this.matchingBinding(binding)) return null;
        const previous = db
          .query<{ principal: string }, [string, string]>(
            "SELECT principal FROM executor_tool_grants WHERE thread=? AND attempt=? ORDER BY epoch DESC LIMIT 1",
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
            "INSERT OR IGNORE INTO executor_tool_grants(principal,thread,epoch,attempt) VALUES(?,?,?,?)",
          )
          .run(grant.principal.id, binding.threadId, binding.epoch, binding.attemptId);
        return write.changes ? grant : null;
      })
      .immediate();
    if (grant) this.live.set(binding.threadId, grant);
    return grant;
  }

  revoke(grant: ExecutorToolGrant) {
    if (this.live.get(grant.binding.threadId) === grant) this.live.delete(grant.binding.threadId);
  }

  authorizes(signer: SignedRequest["signer"], principal: ExecutorPrincipal) {
    const grant = this.lookup(signer);
    return !!grant && Bun.deepEquals(grant.principal, principal) && this.isCurrent(grant);
  }
  isCurrent(grant: ExecutorToolGrant) {
    return (
      this.live.get(grant.binding.threadId) === grant &&
      !!this.matchingBinding(grant.binding) &&
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
       WHERE choice.round=(SELECT id FROM rounds WHERE json_extract(data,'$.threadId')=? ORDER BY rowid LIMIT 1) AND choice.instance=? AND choice.version=?
         AND json_extract(reg.data,'$.version')=choice.version AND json_extract(reg.data,'$.family')=?
         AND json_extract(reg.data,'$.enabled')=1`,
      )
      .get(round.threadId, grant.binding.instanceId, grant.instanceVersion, grant.binding.family);
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
  handleChild,
  observe = false,
}: {
  observe?: boolean;
  handleChild?: (
    request: Extract<SignedRequest, { method: "thread.launchChildren" | "thread.cancelChild" }>,
    actor: LocalActor,
  ) => CommandReceipt | RequestResult;
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
      const operation: RequestMethodDefinition | undefined = tool
        ? EXECUTOR_TOOL_METHODS[tool]
        : request.method === "todo.readAnswer" && grant.methods.has("answerQuestion")
          ? REQUEST_METHODS.readAnswer
          : undefined;
      if (!operation) return refuse("unsupported");
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
      const actor: LocalActor = {
        id: grant.principal.id,
        executor: grant.principal,
        environmentId: grant.environmentId,
        allows: (right, actual) =>
          actual.kind === "thread" &&
          actual.threadId === target.threadId &&
          withinPrincipalCeiling(grant.principal, actual, right) &&
          allows(actual.threadId, right),
      };
      const prior = readReceipt(store.db, grant.principal.id, commandId);
      if (prior && !allows(target.threadId, "thread.view"))
        return {
          kind: "rejected",
          commandId,
          failure: { kind: "missingPermission", target, permission: "thread.view" },
        };
      if (request.method === "todo.answer" || request.method === "todo.readAnswer")
        return acceptTodoReply({
          verifiedActor: { ...actor, executor: grant.principal },
          signedCommand: request,
          writer: store,
        });
      if (request.method === "input.send")
        return applyInputCommand({ actor, command: request, transaction: store });
      const thread = readThread(store.db, target.threadId);
      if (!thread) return refuse("notFound");
      const intent = commandIntent(actor, request.method, target, request.payload);
      if (prior && prior.intent !== intent) return refuse("idConflict");
      if (request.method !== "thread.inspectCheckout") {
        if (request.method === "thread.readChild" || request.method === "thread.cancelChild") {
          const child = store.services.childTransfers.status(request.payload.taskId, thread.id);
          if (!child) return refuse("notFound");
          if (prior) return prior.receipt;
          if (request.method === "thread.readChild") {
            const receipt: CommandReceipt = {
              kind: "accepted",
              commandId,
              result: { kind: "childStatus", child },
            };
            if (!observe)
              store.db.run("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)", [
                actor.id,
                commandId,
                intent,
                JSON.stringify(receipt),
              ]);
            return receipt;
          }
        }
        if (prior) return prior.receipt;
        let result: RequestResult | CommandReceipt;
        if (
          (request.method === "thread.launchChildren" || request.method === "thread.cancelChild") &&
          handleChild
        )
          result = handleChild(request, actor);
        else if (request.method === "attachment.upload") {
          const { attachmentId, transferId } = request.payload;
          const row = store.db
            .query<{ stream: number }, [string, string, string, string, string]>(
              "INSERT OR IGNORE INTO executor_uploads(transfer,attachment,actor,thread,request) VALUES(?,?,?,?,?) RETURNING stream",
            )
            .get(transferId, attachmentId, actor.id, thread.id, canonicalJson(request.payload));
          if (!row || row.stream > 2147483647) return refuse("idConflict");
          result = { kind: "contentTransferOpened", transferId, streamId: row.stream };
        } else return refuse("unsupported");
        const receipt: CommandReceipt =
          "commandId" in result ? result : { kind: "accepted", commandId, result };
        store.db.run("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)", [
          actor.id,
          commandId,
          intent,
          JSON.stringify(receipt),
        ]);
        return receipt;
      }
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
