import * as v from "valibot";

import type { ActiveSteers } from "./durable-replay";
import { DeliveryIdSchema, type Round, type ExecutorTurnUpdate } from "@kraka/protocol";
import {
  matchesAdapterEvent,
  savedBinding,
  replaceBinding,
  latestFrozenSession,
  type OrdinaryStops,
  type ExecutorBinding,
  frozenInput,
  recordAdapterActivity,
  readThread,
  readRound,
  readMessage,
  recoverInputDelivery,
  claimNext,
  recordInputEvidence,
  recordSteerSubmission,
  advanceQueue,
  type FirstSendStore,
  type FrozenDelivery,
  type RoundReport,
  type ThreadSessionBinding,
} from "@kraka/environment";
import type { ExecutorSelection } from "./executor-instances";

export async function resumeBinding(
  s: ExecutorSelection,
  savedThreadId: ExecutorBinding["nativeSessionId"] | null,
  expectedEpoch: number,
  attemptId: Round["attempt"]["attemptId"],
) {
  const opened = await s.probe.driver(expectedEpoch).open(savedThreadId, attemptId, {
    workingDirectory: s.cwd,
    additionalDirectories: [],
    environment: {},
    model: s.model,
    permission: s.snapshot.permission,
  });
  return { opened };
}
export type PreparedSession = Awaited<ReturnType<typeof resumeBinding>>;
export async function reconcileExecutor(
  store: FirstSendStore,
  initial: Round,
  s: ExecutorSelection,
  isCurrent: () => boolean,
  stops: OrdinaryStops,
) {
  const phase = initial.attempt.phase,
    prior = savedBinding(store, initial.threadId);
  if (
    phase.kind !== "unobserved" ||
    phase.seen.kind !== "root" ||
    !prior ||
    prior.family !== s.reg.family ||
    prior.instanceId !== s.reg.instanceId ||
    prior.context !== s.probe.bindingContext ||
    prior.attemptId !== initial.attempt.attemptId
  )
    return false;
  const root = phase.seen.root;
  const { opened } = await resumeBinding(
    s,
    prior.nativeSessionId,
    prior.epoch,
    initial.attempt.attemptId,
  );
  if (opened.kind !== "ok") return false;
  try {
    const original = frozenInput(store, initial.attempt.deliveryId)?.target;
    if (
      !original ||
      !isCurrent() ||
      !replaceBinding(store, prior, { ...prior, epoch: opened.value.epoch })
    )
      return false;
    const support = s.snapshot.matrix.readHistory;
    if (support.kind !== "native") return false;
    const result = await opened.value.invoke(
      { capabilityVersion: s.snapshot.version, support },
      {
        kind: "nativeAction",
        capability: "readHistory",
        action: "readHistory",
        deliveryId: initial.attempt.deliveryId,
        target: root.id,
      },
    );
    if (result.kind !== "ok" || result.value.kind !== "history" || !result.value.rows.length)
      return false;
    const iterator = opened.value.events()[Symbol.asyncIterator]();
    const event = await iterator.next();
    if (event.done || !matchesAdapterEvent(opened.value, event.value) || !isCurrent()) return false;
    const p = event.value.payload;
    if (
      p.kind !== "roundEnded" ||
      p.attemptId !== initial.attempt.attemptId ||
      p.nativeRootTurnId !== root.id
    )
      return false;
    const evidence = recordInputEvidence(store, original, {
      kind: "rootEnded",
      ...initial.attempt,
      root,
      endedAt: p.endedAt,
      endTimeEvidence: p.endTimeEvidence,
      nativeReason: p.outcome.nativeReason,
      ...(p.outcome.reason === "completed"
        ? ({
            outcome: "completed",
            captureId: store.captures.id(initial),
          } as const)
        : { outcome: p.outcome.reason }),
    });
    stops.ended(initial.attempt.attemptId);
    return evidence.kind === "ok";
  } finally {
    await opened.value.close("finished");
  }
}
export async function dispatchExecutor(
  store: FirstSendStore,
  initial: Round,
  selection: ExecutorSelection,
  isCurrent: () => boolean,
  emit: (update: ExecutorTurnUpdate) => void,
  signal: AbortSignal,
  stops: OrdinaryStops,
  steers: ActiveSteers,
  prepared?: PreparedSession,
) {
  const thread = readThread(store.db, initial.threadId),
    message = readMessage(store.db, initial.messageId);
  if (!thread || !message) throw Error("Missing committed executor input");
  if (initial.attempt.phase.kind !== "filed" || initial.attempt.phase.gate !== "eligible") return;
  const { reg, snapshot } = selection;
  const { attemptId, deliveryId } = initial.attempt,
    roundId = initial.id,
    ids = { roundId, attemptId },
    ticket = { attemptId, deliveryId };
  const instance = { family: reg.family, instanceId: reg.instanceId } as const;
  let binding: ThreadSessionBinding | null = null;
  function report(event: RoundReport) {
    if (!binding) throw Error("Unbound executor delivery");
    const result = recordInputEvidence(store, binding, event);
    if (result.kind === "rejected") throw Error(result.reason);
  }
  const failed = (reason: string, message: string | null) => {
    const round = readRound(store.db, roundId);
    if (!round || round.attempt.attemptId !== attemptId) return;
    if (reason === "usageLimited") store.sync.observeQuota(round, { resetAt: null });
    const current = round.attempt.phase;
    if (current.kind === "armed" && reason !== "unsafeToRetry" && reason !== "unexpectedExit")
      report({ kind: "refused", ...ticket, reason: message ?? reason });
    else {
      if (current.kind === "filed" && round.version !== initial.version) return;
      const next =
        current.kind === "filed"
          ? { kind: "notDelivered" as const, reason: message ?? reason, lateReceipt: null }
          : recoverInputDelivery(current, "person", "none");
      store.db.transaction(() => {
        store.setPhase(round, next);
        advanceQueue(store, round.threadId);
      })();
    }
    emit({ kind: "executor.failed", ...ids, reason, message });
  };
  const cwd = store.directory(thread);
  if (!cwd || cwd !== selection.cwd || !isCurrent() || signal.aborted) {
    if (prepared?.opened.kind === "ok") await prepared.opened.value.close("restart");
    return failed("invalidState", "Project directory or instance changed");
  }
  const previous = savedBinding(store, thread.id);
  if (
    previous &&
    (previous.family !== reg.family ||
      previous.instanceId !== reg.instanceId ||
      previous.context !== selection.probe.bindingContext)
  ) {
    if (prepared?.opened.kind === "ok") await prepared.opened.value.close("restart");
    return failed("invalidState", "Saved executor account, history or directory changed");
  }
  const legacy = previous ? null : latestFrozenSession(store, initial);
  const saved = previous?.nativeSessionId ?? legacy?.nativeSessionId ?? null;
  if (legacy && (legacy.family !== reg.family || legacy.instanceId !== instance.instanceId))
    return failed("invalidState", "Saved executor changed");
  const { opened } =
    prepared ??
    (await resumeBinding(selection, saved, previous?.epoch ?? legacy?.epoch ?? 0, attemptId));
  if (opened.kind === "rejected") return failed(opened.reason, opened.message);
  const session = opened.value;
  const todos = session.todos(store.todos, initial, selection.probe.declaration);
  let closing: ReturnType<typeof session.close> | undefined;
  const release = () => {
    closing ??= session.close("shutdown");
    void closing.catch(() => {});
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const sessionId = session.nativeSessionId;
    if (
      !sessionId ||
      (saved !== null && saved !== sessionId) ||
      session.epoch !== (previous?.epoch ?? legacy?.epoch ?? 0) + 1 ||
      !isCurrent() ||
      signal.aborted ||
      store.directory(thread) !== cwd
    )
      return failed("invalidState", "Session binding changed");
    binding = {
      ...instance,
      epoch: session.epoch,
      nativeSessionId: sessionId,
      threadId: thread.id,
      attemptId,
    };
    const delivery: FrozenDelivery = {
      ...ticket,
      target: binding,
      messageVersion: message.version,
      input: {
        id: message.id,
        text: message.text,
        references: message.references,
        attachments: message.attachments,
      },
      parts: [],
    };
    const support = snapshot.matrix.submitTextInput;
    if (support.kind !== "native") return failed("unsupported", null);
    const nextBinding = {
      ...binding,
      family: reg.family,
      nativeSessionId: sessionId,
      context: selection.probe.bindingContext,
    };
    const claim = store.db.transaction(() => {
      if (!Bun.deepEquals(savedBinding(store, thread.id), previous))
        return { kind: "rejected" } as const;
      const claim = claimNext(store, thread.id, delivery, selection.probe.declaration.input);
      if (claim.kind === "ok" && !replaceBinding(store, previous, nextBinding, legacy?.epoch))
        throw Error("executor binding changed");
      return claim;
    })();
    if (claim.kind === "rejected") return;
    await store.captures.before(initial);
    signal.throwIfAborted();
    if (!isCurrent() || store.directory(thread) !== cwd)
      return failed("invalidState", "Directory changed before delivery");
    const events = session.events()[Symbol.asyncIterator]();
    const first = events.next();
    void first.catch(() => {});
    const written = await session.invoke(
      { capabilityVersion: snapshot.version, support },
      { kind: "deliverInput", capability: "submitTextInput", ...ticket, input: claim.value.input },
    );
    if (written.kind === "rejected") return failed(written.reason, written.message);
    if (
      written.value.kind === "service" &&
      Bun.deepEquals(written.value.result, { disposition: "handled" })
    ) {
      report({ kind: "handled", ...ticket, at: Date.now() });
      return;
    }
    if (written.value.kind !== "written" || written.value.deliveryId !== deliveryId)
      throw new Error("Unmatched delivery");
    report({ kind: "written", ...ticket, at: Date.now() });
    let root: import("@kraka/protocol").NativeRootTurnId | null = null;
    let next = await first;
    while (!next.done) {
      const event = next.value,
        p = event.payload;
      if (
        p.kind === "sessionLost" &&
        p.failure.kind === "usageLimit" &&
        matchesAdapterEvent(binding, event)
      )
        store.sync.observeQuota(initial, { resetAt: p.failure.resetAt });
      if (
        p.kind === "sessionLost" &&
        p.observedAt !== undefined &&
        matchesAdapterEvent(binding, event) &&
        (p.failure.kind === "unexpectedExit" ||
          p.failure.kind === "transportError" ||
          p.failure.kind === "protocolError")
      ) {
        if (root) {
          report({ kind: "sessionLost", ...ticket, at: p.observedAt, failure: p.failure });
          emit({
            kind: "executor.failed",
            ...ids,
            reason: p.failure.kind,
            message: "Executor session lost",
          });
        } else failed("unsafeToRetry", "Executor session lost before root evidence");
        return;
      }
      if (todos.event(event)) {
        next = await events.next();
        continue;
      }
      if (
        p.kind === "sessionObservation" ||
        p.kind === "sessionObservationLinked" ||
        p.kind === "fileChanged"
      ) {
        recordAdapterActivity(store.sync, binding, roundId, event, root);
        next = await events.next();
        continue;
      }
      if (
        !matchesAdapterEvent(binding, event) ||
        !("attemptId" in p) ||
        p.attemptId !== attemptId ||
        ("deliveryId" in p && p.deliveryId !== deliveryId)
      )
        throw new Error("Foreign executor event");
      switch (p.kind) {
        case "deliveryReceived":
          if (p.receipt.kind === "input")
            report({
              kind: "received",
              ...ticket,
              proof: { sessionId: p.receipt.sessionId, itemId: p.receipt.itemId },
            });
          break;
        case "roundStarted": {
          root = p.nativeRootTurnId;
          const update = session.view.update?.(p, ids);
          const policy =
            update?.kind === "round.started" && update.enforcement === "adapter"
              ? {
                  toolPolicy: {
                    selectedMode: update.selectedMode,
                    effectiveMode: update.effectiveMode,
                    supportedModes: update.supportedModes,
                    enforcement: update.enforcement,
                  },
                }
              : {};
          report({
            kind: "rootStarted",
            ...ticket,
            root: { id: p.nativeRootTurnId, sessionId, beganAt: p.at, ...policy },
          });
          const stopSupport = snapshot.matrix.stopRound,
            readSupport = snapshot.matrix.readHistory;
          if (stopSupport.kind === "native")
            stops.endpoints.set(attemptId, {
              root: p.nativeRootTurnId,
              interrupt: async (id) =>
                (
                  await session.invoke(
                    { capabilityVersion: snapshot.version, support: stopSupport },
                    { kind: "stop", capability: "stopRound", deliveryId: id, attemptId },
                  )
                ).kind === "ok",
              inspect: async () => {
                if (readSupport.kind === "native")
                  await session.invoke(
                    { capabilityVersion: snapshot.version, support: readSupport },
                    {
                      kind: "nativeAction",
                      capability: "readHistory",
                      deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
                      action: "readHistory",
                      target: p.nativeRootTurnId,
                    },
                  );
              },
            });
          const steer = selection.probe.declaration.steering.insertCurrent;
          if (steer.support.kind === "native" && steer.accepts.includes("text")) {
            const support = steer.support;
            steers.set(attemptId, async (input, id) => {
              const submission = await session.invoke(
                { capabilityVersion: snapshot.version, support },
                {
                  kind: "steer",
                  capability: "steerCurrentRound",
                  attemptId,
                  deliveryId: id,
                  mode: "insertCurrent",
                  input,
                },
              );
              recordSteerSubmission(
                store,
                roundId,
                attemptId,
                input.id,
                submission.kind === "ok" &&
                  submission.value.kind === "written" &&
                  submission.value.deliveryId === id
                  ? "submitted"
                  : submission.kind === "rejected" && submission.reason !== "unsafeToRetry"
                    ? "rejected"
                    : "unknown",
              );
            });
          }
          if (update) emit(update);
          break;
        }
        case "toolActivity": {
          const activity = recordAdapterActivity(store.sync, binding, roundId, event, root);
          if (activity === "conflict") throw Error("Conflicting tool event");
          if (activity === "unchanged") break;
          const update = session.view.update?.(p, ids);
          if (update) emit(update);
          break;
        }
        case "contentDelta":
          emit({
            kind: p.finalText === null ? "assistant.delta" : "assistant.final",
            ...ids,
            itemId: p.itemId,
            text: p.finalText ?? p.text,
          });
          break;

        case "roundEnded": {
          const root = { id: p.nativeRootTurnId, sessionId, beganAt: null };
          store.db.transaction(() => {
            if (p.outcome.reason === "failed" && p.outcome.failure.kind === "usageLimit")
              store.sync.observeQuota(initial, { resetAt: p.outcome.failure.resetAt });
            report({
              kind: "rootEnded",
              ...ticket,
              root,
              endedAt: p.endedAt,
              endTimeEvidence: p.endTimeEvidence,
              nativeReason: p.outcome.nativeReason,
              ...(p.outcome.reason === "completed"
                ? ({
                    outcome: "completed",
                    captureId: store.captures.id(initial),
                  } as const)
                : { outcome: p.outcome.reason }),
            });
          })();
          stops.ended(attemptId);
          if (p.outcome.reason === "failed")
            emit({
              kind: "executor.failed",
              ...ids,
              reason: p.outcome.failure.kind,
              message: p.outcome.nativeReason,
            });
          emit({
            kind: "round.ended",
            ...ids,
            nativeRootTurnId: root.id,
            endedAt: p.endedAt,
            endTimeEvidence: p.endTimeEvidence,
            outcome: p.outcome.reason,
          });
          return;
        }
      }
      next = await events.next();
    }
    throw new Error("executor session ended before its root");
  } catch {
    const interrupted = session.view.interrupted?.();
    failed(
      interrupted?.reason ?? "unsafeToRetry",
      interrupted?.message ?? "Executor delivery outcome could not be confirmed",
    );
  } finally {
    stops.endpoints.delete(attemptId);
    steers.delete(attemptId);
    todos.close();
    signal.removeEventListener("abort", release);
    await (closing ?? session.close("finished"));
  }
}
