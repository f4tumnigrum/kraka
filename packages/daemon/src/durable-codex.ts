import * as v from "valibot";

import type { ActiveSteers } from "./durable-replay";
import {
  canonicalJson,
  DeliveryIdSchema,
  CaptureIdSchema,
  type Round,
  type ExecutorTurnUpdate,
} from "@kraka/protocol";
import {
  matchesAdapterEvent,
  savedBinding,
  replaceBinding,
  latestFrozenSession,
  type OrdinaryStops,
  type CodexBinding,
  frozenInput,
  bindTodoSession,
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
import type { CodexSelection } from "./codex-instances";

export function bindingContext(s: CodexSelection) {
  return canonicalJson({
    instance: s.reg.instanceId,
    credential: s.reg.credential,
    version: s.reg.version,
    account: s.probe.accountContext,
    historyRoot: s.reg.driver.historyRoot,
    nativeHome: s.probe.nativeHome,
    configurationRoot: s.reg.driver.configurationRoot,
    cwd: s.cwd,
  });
}
export async function resumeBinding(
  s: CodexSelection,
  savedThreadId: CodexBinding["nativeSessionId"] | null,
  expectedEpoch: number,
  attemptId: Round["attempt"]["attemptId"],
) {
  const adapter = s.adapter(expectedEpoch);
  const opened = await adapter.open({
    instance: { family: "codex", instanceId: s.reg.instanceId },
    attemptId,
    resume: savedThreadId,
    setup: {
      workingDirectory: s.cwd,
      additionalDirectories: [],
      environment: {},
      model: s.model,
      permission: s.snapshot.permission,
    },
  });
  return { adapter, opened };
}
export type PreparedSession = Awaited<ReturnType<typeof resumeBinding>>;
export async function reconcileCodex(
  store: FirstSendStore,
  initial: Round,
  s: CodexSelection,
  isCurrent: () => boolean,
  stops: OrdinaryStops,
) {
  const phase = initial.attempt.phase,
    prior = savedBinding(store, initial.threadId);
  if (
    phase.kind !== "unobserved" ||
    phase.seen.kind !== "root" ||
    !prior ||
    prior.context !== bindingContext(s) ||
    prior.attemptId !== initial.attempt.attemptId
  )
    return false;
  const root = phase.seen.root;
  const { adapter, opened } = await resumeBinding(
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
    const result = await adapter.invoke(
      opened.value,
      {
        family: "codex",
        instanceId: prior.instanceId,
        capabilityVersion: s.snapshot.version,
        capability: "readHistory",
        support,
      },
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
    const iterator = adapter.events(opened.value, null)[Symbol.asyncIterator]();
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
            captureId: v.parse(CaptureIdSchema, crypto.randomUUID()),
          } as const)
        : { outcome: p.outcome.reason }),
    });
    stops.ended(initial.attempt.attemptId);
    return evidence.kind === "ok";
  } finally {
    await adapter.close(opened.value, "finished");
  }
}
export async function dispatchCodex(
  store: FirstSendStore,
  initial: Round,
  selection: CodexSelection,
  isCurrent: () => boolean,
  emit: (update: ExecutorTurnUpdate) => void,
  signal: AbortSignal,
  stops: OrdinaryStops,
  steers: ActiveSteers,
  prepared?: PreparedSession,
) {
  const thread = readThread(store.db, initial.threadId),
    message = readMessage(store.db, initial.messageId);
  if (!thread || !message) throw Error("Missing committed Codex input");
  if (initial.attempt.phase.kind !== "filed" || initial.attempt.phase.gate !== "eligible") return;
  const { reg, snapshot } = selection;
  const { attemptId, deliveryId } = initial.attempt,
    roundId = initial.id,
    ids = { roundId, attemptId },
    ticket = { attemptId, deliveryId };
  const instance = { family: "codex", instanceId: reg.instanceId } as const;
  let binding: ThreadSessionBinding | null = null;
  function report(event: RoundReport) {
    if (!binding) throw Error("Unbound Codex delivery");
    const result = recordInputEvidence(store, binding, event);
    if (result.kind === "rejected") throw Error(result.reason);
  }
  const failed = (reason: string, message: string | null) => {
    const round = readRound(store.db, roundId);
    if (!round || round.attempt.attemptId !== attemptId) return;
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
    if (prepared?.opened.kind === "ok")
      await prepared.adapter.close(prepared.opened.value, "restart");
    return failed("invalidState", "Project directory or instance changed");
  }
  const previous = savedBinding(store, thread.id);
  if (previous && previous.context !== bindingContext(selection)) {
    if (prepared?.opened.kind === "ok")
      await prepared.adapter.close(prepared.opened.value, "restart");
    return failed("invalidState", "Saved Codex account, history or directory changed");
  }
  const legacy = previous ? null : latestFrozenSession(store, initial);
  const saved = previous?.nativeSessionId ?? legacy?.nativeSessionId ?? null;
  if (legacy && (legacy.family !== "codex" || legacy.instanceId !== instance.instanceId))
    return failed("invalidState", "Saved executor changed");
  const { adapter, opened } =
    prepared ??
    (await resumeBinding(selection, saved, previous?.epoch ?? legacy?.epoch ?? 0, attemptId));
  if (opened.kind === "rejected") return failed(opened.reason, opened.message);
  const session = opened.value;
  const todos = bindTodoSession(
    store.todos,
    initial,
    session,
    adapter,
    selection.probe.declaration,
    (key) => !session.handle.lost && !session.handle.closed && session.handle.callbacks.has(key),
  );
  let closing: ReturnType<typeof adapter.close> | undefined;
  const release = () => {
    closing ??= adapter.close(session, "shutdown");
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
      family: "codex" as const,
      nativeSessionId: sessionId,
      context: bindingContext(selection),
    };
    const claim = store.db.transaction(() => {
      if (!Bun.deepEquals(savedBinding(store, thread.id), previous))
        return { kind: "rejected" } as const;
      const claim = claimNext(store, thread.id, delivery, selection.probe.declaration.input);
      if (claim.kind === "ok" && !replaceBinding(store, previous, nextBinding, legacy?.epoch))
        throw Error("Codex binding changed");
      return claim;
    })();
    if (claim.kind === "rejected") return;
    const events = adapter.events(session, null)[Symbol.asyncIterator]();
    const first = events.next();
    void first.catch(() => {});
    const written = await adapter.invoke(
      session,
      { ...instance, capabilityVersion: snapshot.version, capability: "submitTextInput", support },
      { kind: "deliverInput", capability: "submitTextInput", ...ticket, input: claim.value.input },
    );
    if (written.kind === "rejected") return failed(written.reason, written.message);
    if (written.value.kind !== "written" || written.value.deliveryId !== deliveryId)
      throw new Error("Unmatched delivery");
    report({ kind: "written", ...ticket, at: Date.now() });
    let root: import("@kraka/protocol").NativeRootTurnId | null = null;
    let next = await first;
    while (!next.done) {
      const event = next.value,
        p = event.payload;
      if (todos.event(event)) {
        next = await events.next();
        continue;
      }
      if (p.kind === "sessionObservation" || p.kind === "fileChanged") {
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
        throw new Error("Foreign Codex event");
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
          report({
            kind: "rootStarted",
            ...ticket,
            root: { id: p.nativeRootTurnId, sessionId, beganAt: p.at },
          });
          const stopSupport = snapshot.matrix.stopRound,
            readSupport = snapshot.matrix.readHistory;
          if (stopSupport.kind === "native")
            stops.endpoints.set(attemptId, {
              root: p.nativeRootTurnId,
              interrupt: async (id) =>
                (
                  await adapter.invoke(
                    session,
                    {
                      ...instance,
                      capability: "stopRound",
                      capabilityVersion: snapshot.version,
                      support: stopSupport,
                    },
                    { kind: "stop", capability: "stopRound", deliveryId: id, attemptId },
                  )
                ).kind === "ok",
              inspect: async () => {
                if (readSupport.kind === "native")
                  await adapter.invoke(
                    session,
                    {
                      ...instance,
                      capability: "readHistory",
                      capabilityVersion: snapshot.version,
                      support: readSupport,
                    },
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
              const submission = await adapter.invoke(
                session,
                {
                  ...instance,
                  capability: "steerCurrentRound",
                  capabilityVersion: snapshot.version,
                  support,
                },
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
          emit({
            kind: "round.started",
            ...ids,
            nativeSessionId: sessionId,
            nativeRootTurnId: p.nativeRootTurnId,
            startedAt: p.at,
            selectedMode: snapshot.permission.selected,
            effectiveMode: snapshot.permission.selected,
            effectivePolicy: session.handle.policy,
            supportedModes: [snapshot.permission.selected],
            enforcement: "native",
          });
          break;
        }
        case "toolActivity": {
          const callId = p.callId;
          const activity = recordAdapterActivity(store.sync, binding, roundId, event, root);
          if (activity === "conflict") throw Error("Conflicting tool event");
          if (activity === "unchanged") break;
          if (p.phase === "started")
            emit({
              kind: "tool.started",
              ...ids,
              callId,
              ...v.parse(v.object({ command: v.string() }), p.input),
            });
          else if (p.phase === "progress")
            emit({
              kind: "tool.output",
              ...ids,
              callId,
              ...v.parse(v.object({ text: v.string() }), p.output),
            });
          else {
            const o = v.parse(
              v.object({ text: v.nullable(v.string()), exitCode: v.nullable(v.number()) }),
              p.output,
            );
            emit({ kind: "tool.ended", ...ids, callId, output: o.text, exitCode: o.exitCode });
          }
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
          if (
            p.endTimeEvidence.source !== "executorReported" ||
            p.endedAt !== p.endTimeEvidence.executorEndedAt
          )
            throw new Error("Missing Codex end boundary");
          const root = { id: p.nativeRootTurnId, sessionId, beganAt: null };
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
                  captureId: v.parse(CaptureIdSchema, crypto.randomUUID()),
                } as const)
              : { outcome: p.outcome.reason }),
          });
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
    throw new Error("Codex session ended before its root");
  } catch {
    const child = session.handle.rpc.child;
    const exited = child.exitCode !== null || child.signalCode !== null;
    failed(
      exited ? "unexpectedExit" : "unsafeToRetry",
      exited
        ? "Codex process exited before a verified root end"
        : "Codex delivery outcome could not be confirmed",
    );
  } finally {
    stops.endpoints.delete(attemptId);
    steers.delete(attemptId);
    todos.close();
    signal.removeEventListener("abort", release);
    await (closing ?? adapter.close(session, "finished"));
  }
}
