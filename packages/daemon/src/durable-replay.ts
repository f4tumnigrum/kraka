import * as v from "valibot";
import { NativeItemIdSchema } from "@kraka/protocol";
import {
  advanceQueue,
  claimNext,
  type FirstSendStore,
  frozenInput,
  type ProviderAdapter,
  type RecoveryScope,
  readMessage,
  readRound,
  readThread,
  recordInputEvidence,
  recordSteerRead,
  recoverInputDelivery,
  runReplayTurn,
} from "@kraka/environment";
import type { CommandId, DeliveryId, Message, ReplayTurnUpdate, Round } from "@kraka/protocol";
export type ActiveSteers = Map<
  string,
  (
    message: Pick<Message, "id" | "text" | "references" | "attachments">,
    deliveryId: DeliveryId,
  ) => Promise<void>
>;
export async function dispatchReplay<H extends object>(
  store: FirstSendStore,
  initial: Round,
  commandId: CommandId,
  replay: { adapter: ProviderAdapter<"replay", H>; expectedText: string; modelId: string },
  update: (value: ReplayTurnUpdate) => void,
  signal: AbortSignal,
  steers: ActiveSteers,
) {
  const thread = readThread(store.db, initial.threadId),
    message = readMessage(store.db, initial.messageId);
  if (!thread || !message) throw Error("Committed input missing");
  const frozen = frozenInput(store, initial.attempt.deliveryId);
  const input = frozen?.input ?? message;
  const directory = () => {
    const path = store.directory(thread);
    if (!path) throw Error("Registered directory unavailable");
    return path;
  };
  let claimed = false;
  try {
    await runReplayTurn({
      ...replay,
      request: {
        kind: "replay.run",
        commandId,
        permission: "ask",
        input: { text: input.text, references: input.references, attachments: input.attachments },
      },
      workingDirectory: directory(),
      signal,
      persisted: {
        todos: store.todos,
        thread,
        round: initial,
        directory,
        messageVersion: message.version,
        resume: frozen?.target.nativeSessionId ?? null,
        prepare(delivery, guarantee) {
          directory();
          const result = claimNext(store, thread.id, delivery, guarantee);
          if (result.kind === "rejected") throw Error(result.reason);
          claimed = true;
          return result.value;
        },
        report(binding, event) {
          const result = recordInputEvidence(store, binding, event);
          if (result.kind === "rejected") throw Error(result.reason);
        },
        previousReceipt(event) {
          const p = event.payload;
          if (p.kind === "deliveryReceived" && p.receipt.kind === "input")
            recordInputEvidence(
              store,
              {
                family: event.family,
                instanceId: event.instanceId,
                nativeSessionId: event.sessionId,
                epoch: event.epoch,
              },
              {
                kind: "received",
                attemptId: p.attemptId,
                deliveryId: p.deliveryId,
                proof: { sessionId: p.receipt.sessionId, itemId: p.receipt.itemId },
              },
            );
        },
        steer(send) {
          steers.set(initial.attempt.attemptId, send);
        },
        readSteer(attempt, message) {
          recordSteerRead(store, thread.id, attempt, message);
        },
      },
      emit(event) {
        if (event.kind === "rejected") throw Error(event.failure.kind);
        if ("commandId" in event) return;
        if (
          event.kind === "tool.started" ||
          event.kind === "tool.ended" ||
          event.kind === "assistant.final"
        ) {
          store.db.run("INSERT OR REPLACE INTO turn_work VALUES(?,?,?)", [
            event.roundId,
            event.kind,
            JSON.stringify(event),
          ]);
        }
        update(event);
      },
    });
  } catch (error) {
    const round = readRound(store.db, initial.id);
    if (
      !round ||
      round.attempt.attemptId !== initial.attempt.attemptId ||
      (!claimed && round.version !== initial.version)
    )
      return;
    const phase = round.attempt.phase;
    const next =
      phase.kind === "filed"
        ? {
            kind: "notDelivered" as const,
            reason: error instanceof Error ? error.message : "open failed",
            lateReceipt: null,
          }
        : recoverInputDelivery(phase, "person", "none");
    store.db.transaction(() => {
      store.setPhase(round, next);
      advanceQueue(store, thread.id);
    })();
  } finally {
    steers.delete(initial.attempt.attemptId);
  }
}

export async function inspectOriginalInput<H extends object>(
  store: FirstSendStore,
  round: Round,
  replay: {
    adapter: ProviderAdapter<"replay", H>;
    modelId: string;
    recovery?: RecoveryScope;
    confirmFencedAbsence?: (delivery: DeliveryId) => Promise<boolean>;
  },
) {
  const { attemptId, deliveryId } = round.attempt;
  const old = frozenInput(store, deliveryId),
    scope = replay.recovery;
  const thread = readThread(store.db, round.threadId);
  const path = thread ? store.directory(thread) : null;
  if (!old || !path || !old.target.nativeSessionId || old.target.family !== "replay" || !scope)
    return;
  const instance = { family: "replay" as const, instanceId: old.target.instanceId };
  const declaration = await replay.adapter.capabilities(instance);
  if (declaration.kind !== "ok" || declaration.value.input.query !== "acrossRestart") return;
  const support = declaration.value.matrix.readHistory;
  if (support.kind === "unsupported") return;
  const opened = await replay.adapter.open({
    instance,
    attemptId,
    resume: old.target.nativeSessionId,
    setup: {
      workingDirectory: path,
      additionalDirectories: [],
      environment: {},
      model: { id: replay.modelId, options: {} },
      permission: { ceiling: "ask", selected: "ask" },
    },
  });
  if (opened.kind !== "ok") return;
  const session = opened.value;
  try {
    if (
      session.family !== old.target.family ||
      session.instanceId !== old.target.instanceId ||
      session.nativeSessionId !== old.target.nativeSessionId ||
      session.epoch !== old.target.epoch
    )
      return;
    const result = await replay.adapter.invoke(
      session,
      {
        ...instance,
        capability: "readHistory",
        support,
        capabilityVersion: declaration.value.version,
      },
      { kind: "inspect", capability: "readHistory", attemptId, deliveryId, subject: "input" },
    );
    if (result.kind !== "ok" || result.value.kind !== "inspection") return;
    const evidence = result.value.result;
    if (evidence.kind === "found")
      recordInputEvidence(store, session, {
        kind: "received",
        attemptId,
        deliveryId,
        proof: {
          sessionId: session.nativeSessionId,
          itemId: v.parse(NativeItemIdSchema, evidence.nativeId),
        },
      });
    if (evidence.kind === "definitelyAbsent" && (await replay.confirmFencedAbsence?.(deliveryId)))
      recordInputEvidence(store, session, { kind: "absentAfterFence", attemptId, deliveryId });
  } finally {
    await replay.adapter.close(session, "finished");
  }
}
