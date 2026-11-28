import * as v from "valibot";
import {
  AttemptIdSchema,
  ContextTransferIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  RoundIdSchema,
  MessageSchema,
  SessionTransitionReadSchema,
  REQUEST_METHODS,
  type CommandId,
  type CommandReceipt,
  type SessionTransitionPreview,
  type SessionTransitionRead,
  type ThreadId,
} from "@kraka/protocol";
import { type FirstSendStore } from "./first-send-store";
import { checkCommand, type LocalActor, recordCommand, reject } from "./command-receipts";
import { SessionBindings } from "./session-binding";
import { freezeTextHandoff } from "./session-delivery";
import {
  loadPreview,
  samePreview,
  type TransitionFacts,
  type ApprovedPreview,
  type PreviewInput,
} from "./session-preview";
import {
  type AdapterFamily,
  type AdapterSession,
  type ProviderAdapter,
  type CapabilityDeclaration,
  type AdapterCommand,
  type InvocationResult,
} from "./adapter-contract";
import { fileInputRound, loadQueue, advanceQueue } from "./input-store";
import type { ThreadSessionBinding } from "./executor-records";
export type TransitionChannel = {
  adapter: Pick<ProviderAdapter<AdapterFamily, object>, "events" | "close"> & {
    invoke(
      session: AdapterSession<AdapterFamily, object>,
      permit: import("./adapter-contract").ActionPermit<
        AdapterFamily,
        | "startSession"
        | "changeModel"
        | "clearSession"
        | "forkAtRound"
        | "rollbackRounds"
        | "readHistory"
      >,
      command: Extract<
        AdapterCommand,
        { capability: "changeModel" | "startSession" } | { kind: "nativeAction" }
      >,
    ): Promise<import("./adapter-contract").AdapterCallResult<InvocationResult>>;
  };
  session: AdapterSession<AdapterFamily, object>;
  declaration: Pick<CapabilityDeclaration, "version" | "matrix">;
  context: string;
};
export interface TransitionHost {
  authorized?(actor: LocalActor, payload: PreviewInput): boolean;
  prepare?(
    actor: LocalActor,
    threadId: ThreadId,
    target: ThreadSessionBinding["instanceId"] | null,
  ): Promise<void>;
  clearTarget(actor: LocalActor, threadId: ThreadId): import("./session-clear").ClearTarget | null;
  facts(actor: LocalActor, payload: PreviewInput): TransitionFacts;
  open(
    preview: ApprovedPreview,
    attemptId: ThreadSessionBinding["attemptId"],
    actor: LocalActor,
  ): Promise<TransitionChannel | null>;
  // Ownership of this verified handle passes to the normal first-turn dispatcher at commit.
  ready(channel: TransitionChannel, roundId: ReturnType<typeof fileInputRound>["id"]): void;
}
function persist(store: FirstSendStore, op: SessionTransitionRead, busy: boolean) {
  store.db.run(
    "INSERT INTO session_switches(thread,operation,data,busy) VALUES(?,?,?,?) ON CONFLICT(thread,operation) DO UPDATE SET data=excluded.data,busy=excluded.busy",
    [op.threadId, op.operationId, JSON.stringify(op), Number(busy)],
  );
}
export function readSessionTransition(
  store: FirstSendStore,
  actor: LocalActor,
  threadId: ThreadId,
  operationId: CommandId,
) {
  if (
    actor.environmentId !== store.writer.environmentId ||
    !actor.allows("thread.view", { kind: "thread", threadId })
  )
    return null;
  const row = store.db
    .query<{ data: string }, [string, string]>(
      "SELECT data FROM session_switches WHERE thread=? AND operation=?",
    )
    .get(threadId, operationId);
  return row ? v.parse(SessionTransitionReadSchema, JSON.parse(row.data)) : null;
}
function readback(p: ApprovedPreview, operationId: CommandId): SessionTransitionRead {
  const base = {
    threadId: p.threadId,
    operationId,
    target: p.target,
    priorBinding: p.expectedBinding,
    currentBinding: p.expectedBinding,
  };
  if (p.kind === "createWithHandoff")
    return {
      ...base,
      kind: p.kind,
      transferId: v.parse(ContextTransferIdSchema, crypto.randomUUID()),
      deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
      injection: "pending",
    };
  if (p.kind === "changeModel") return { ...base, kind: p.kind, effectiveAt: p.effectiveAt };
  return { ...base, kind: p.kind };
}
export async function invokeTransition(
  channel: TransitionChannel,
  cmd: Extract<
    AdapterCommand,
    { capability: "changeModel" | "startSession" } | { kind: "nativeAction" }
  >,
): Promise<InvocationResult | null> {
  const { session, adapter, declaration } = channel;
  const support = declaration.matrix[cmd.capability];
  if (!support || support.kind === "unsupported") return null;
  const result = await adapter.invoke(
    session,
    {
      instanceId: session.instanceId,
      family: session.family,
      capabilityVersion: declaration.version,
      capability: cmd.capability,
      support,
    },
    cmd,
  );
  return result.kind === "ok" ? result.value : null;
}
export async function switchThreadSession(
  store: FirstSendStore,
  host: TransitionHost,
  {
    actor,
    previewId,
    commandId,
  }: { actor: LocalActor; previewId: SessionTransitionPreview["id"]; commandId: CommandId },
): Promise<CommandReceipt> {
  const saved = loadPreview(store, previewId, actor.id);
  if (!saved || saved.preview.kind === "reject") return reject(commandId, "notFound");
  const p = saved.preview,
    { threadId } = p;
  const ctx = { actor, commandId, transaction: store },
    target = { kind: "thread" as const, threadId },
    method = REQUEST_METHODS.switchSession;
  const prior = checkCommand(ctx, method, { previewId }, target, ["thread.view"]);
  if (
    !actor.allows("thread.send", target) ||
    !actor.allows("thread.view", target) ||
    actor.environmentId !== store.writer.environmentId
  )
    return prior.receipt ?? reject(commandId, "notFound");
  const authorized = () =>
    actor.allows("thread.send", target) &&
    actor.allows("thread.view", target) &&
    (host.authorized?.(actor, saved.payload) ?? !!host.facts(actor, saved.payload).target);
  if (!authorized()) return reject(commandId, prior.receipt ? "notFound" : "invalidState");
  if (prior.receipt) return prior.receipt;
  const current = () =>
    authorized() && samePreview(store, actor, saved, host.facts(actor, saved.payload));
  const op = readback(p, commandId);
  let claimed = false;
  const receipt = recordCommand(
    ctx,
    method,
    { previewId },
    target,
    () => {
      if (
        !current() ||
        loadQueue(store, threadId, true).rows.length ||
        store.db
          .query(
            "SELECT 1 FROM session_switches WHERE thread=? AND (busy=1 OR operation=?) UNION ALL SELECT 1 FROM session_clear WHERE thread=? AND json_extract(data,'$.state.kind') IN ('accepted','unknown')",
          )
          .get(threadId, commandId, threadId)
      )
        return reject(commandId, "invalidState");
      persist(store, op, true);
      claimed = true;
      return { kind: "sessionSwitchAccepted", threadId, operationId: commandId };
    },
    ["thread.view"],
  );
  if (!claimed) return receipt;
  let channel: TransitionChannel | null = null,
    retained = false,
    dispatched = false;
  const attemptId = v.parse(AttemptIdSchema, crypto.randomUUID());
  const messageId = v.parse(MessageIdSchema, crypto.randomUUID()),
    input = { ...saved.payload.proposedInput, id: messageId };
  try {
    channel = await host.open(p, attemptId, actor);
    if (!channel || !current()) return receipt;
    const { session, declaration } = channel;
    const epoch = (p.expectedBinding?.epoch ?? 0) + 1;
    if (
      session.family !== p.target.family ||
      session.instanceId !== p.target.instanceId ||
      !session.nativeSessionId ||
      declaration.version !== p.target.capabilityVersion ||
      (p.kind === "resumeSession" && session.nativeSessionId !== p.nativeSessionId) ||
      ((p.kind === "reuseSession" || p.kind === "changeModel") &&
        session.nativeSessionId !== p.expectedBinding?.nativeSessionId) ||
      (p.kind === "createWithHandoff" &&
        p.expectedBinding?.instanceId === session.instanceId &&
        p.expectedBinding.nativeSessionId === session.nativeSessionId)
    )
      return receipt;
    const next: ThreadSessionBinding = {
      threadId,
      attemptId,
      epoch,
      family: session.family,
      instanceId: session.instanceId,
      nativeSessionId: session.nativeSessionId,
    };
    if (op.kind === "createWithHandoff" && p.kind === "createWithHandoff") {
      const frozen = await freezeTextHandoff(store, {
        previewId,
        source: p.source,
        expectedBinding: p.expectedBinding,
        targetBinding: next,
        attemptId,
        deliveryId: op.deliveryId,
        transferId: op.transferId,
        input,
        messageVersion: v.parse(ObjectVersionSchema, "1"),
      });
      if (frozen.kind === "conflict" || !current()) return receipt;
      const events = channel.adapter.events(session, null)[Symbol.asyncIterator]();
      const first = events.next();
      void first.catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        dispatched = true;
        const result = await Promise.race([
          invokeTransition(channel, {
            kind: "service",
            capability: "startSession",
            deliveryId: op.deliveryId,
            request: {
              kind: "handoff",
              ...frozen.delivery.handoff,
              entries: frozen.delivery.handoffEntries,
            },
          }),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 30000);
          }),
        ]);
        if (
          !result ||
          result.kind !== "service" ||
          !Bun.deepEquals(result.result, {
            kind: "injected",
            transferId: op.transferId,
            deliveryId: op.deliveryId,
            nativeSessionId: session.nativeSessionId,
          })
        )
          return receipt;
      } finally {
        clearTimeout(timer);
        void events.return?.().catch(() => {});
      }
    } else if (p.kind === "changeModel") {
      const result = await invokeTransition(channel, {
        kind: "service",
        capability: "changeModel",
        deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
        request: { kind: "changeModel", model: p.target.model },
      });
      if (
        result?.kind !== "service" ||
        !Bun.deepEquals(result.result, { model: p.target.model, effectiveAt: p.effectiveAt })
      )
        return receipt;
    }
    if (!current() || loadQueue(store, threadId, true).rows.length) return receipt;
    const roundId = v.parse(RoundIdSchema, crypto.randomUUID());
    const commit = new SessionBindings(store, channel.context, (binding) => {
      const message = v.parse(MessageSchema, {
        ...input,
        threadId,
        roundId,
        author: { kind: "person", id: actor.id },
        version: "1",
      });
      store.db.run("INSERT INTO messages VALUES(?,?)", [messageId, JSON.stringify(message)]);
      const round = fileInputRound(store, loadQueue(store, threadId), roundId, messageId, {
        attemptId,
        deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
      });
      store.sync.record([
        { objectType: "message", value: message },
        { objectType: "round", value: round },
      ]);
      store.db.run("INSERT INTO round_executors VALUES(?,?,?,?)", [
        roundId,
        p.target.instanceId,
        p.target.configurationVersion,
        JSON.stringify(p.target.model),
      ]);
      advanceQueue(store, threadId);
      persist(
        store,
        op.kind === "createWithHandoff"
          ? { ...op, currentBinding: binding, injection: "injected" }
          : { ...op, currentBinding: binding },
        false,
      );
    });
    if (await commit.replace(p.expectedBinding, next)) {
      retained = true;
      host.ready(channel, roundId);
      store.sync.notify();
    }
  } catch {
    // A lost adapter reply leaves the recorded intent available under the original command.
  } finally {
    if (!retained) {
      persist(
        store,
        op.kind === "createWithHandoff"
          ? { ...op, injection: dispatched ? "unknown" : "failed" }
          : op,
        dispatched,
      );
      if (channel) await channel.adapter.close(channel.session, "restart");
    }
  }
  return receipt;
}
