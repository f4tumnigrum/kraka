import * as v from "valibot";
import { CaptureIdSchema, type Round, type ExecutorTurnUpdate } from "@kraka/protocol";
import {
  matchesAdapterEvent,
  bindTodoSession,
  readThread,
  readRound,
  readMessage,
  recoverInputDelivery,
  claimNext,
  recordInputEvidence,
  advanceQueue,
  type FirstSendStore,
  type FrozenDelivery,
  type RoundReport,
  type ThreadSessionBinding,
} from "@kraka/environment";
import type { CodexSelection } from "./codex-instances";

export async function dispatchCodex(
  store: FirstSendStore,
  initial: Round,
  selection: CodexSelection,
  isCurrent: () => boolean,
  emit: (update: ExecutorTurnUpdate) => void,
  signal: AbortSignal,
) {
  const thread = readThread(store.db, initial.threadId),
    message = readMessage(store.db, initial.messageId);
  if (!thread || !message) throw Error("Missing committed Codex input");
  if (initial.attempt.phase.kind !== "filed" || initial.attempt.phase.gate !== "eligible") return;
  const { adapter, reg, model, snapshot } = selection;
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
    if (reason === "usageLimited") store.sync.observeQuota(round, { resetAt: null });
    const current = round.attempt.phase;
    if (current.kind === "armed" && reason !== "unsafeToRetry")
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
  if (!cwd || cwd !== selection.cwd || !isCurrent() || signal.aborted)
    return failed("invalidState", "Project directory or instance changed");
  const opened = await adapter.open({
    instance,
    resume: null,
    attemptId,
    setup: {
      workingDirectory: cwd,
      additionalDirectories: [],
      environment: {},
      model,
      permission: snapshot.permission,
    },
  });
  if (opened.kind === "rejected") return failed(opened.reason, opened.message);
  const session = opened.value;
  const todos = bindTodoSession(
    store.todos,
    initial,
    session,
    adapter,
    selection.probe.declaration,
  );
  let closing: ReturnType<typeof adapter.close> | undefined;
  const release = () => {
    closing ??= adapter.close(session, "shutdown");
    void closing.catch(() => {});
  };
  signal.addEventListener("abort", release, { once: true });
  try {
    const sessionId = session.nativeSessionId;
    if (!sessionId || !isCurrent() || signal.aborted || store.directory(thread) !== cwd)
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
    const claim = claimNext(store, thread.id, delivery, selection.probe.declaration.input);
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
      if (todos.event(event)) {
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
        case "roundStarted":
          report({
            kind: "rootStarted",
            ...ticket,
            root: { id: p.nativeRootTurnId, sessionId, beganAt: p.at },
          });
          emit({
            kind: "round.started",
            ...ids,
            nativeSessionId: sessionId,
            nativeRootTurnId: p.nativeRootTurnId,
            startedAt: p.at,
            selectedMode: "ask",
            effectiveMode: "ask",
            supportedModes: ["ask"],
            enforcement: "native",
          });
          break;
        case "toolActivity": {
          const callId = p.callId;
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
                    captureId: v.parse(CaptureIdSchema, crypto.randomUUID()),
                  } as const)
                : { outcome: p.outcome.reason }),
            });
          })();
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
    failed("unsafeToRetry", "Codex delivery outcome could not be confirmed");
  } finally {
    todos.close();
    signal.removeEventListener("abort", release);
    await (closing ?? adapter.close(session, "finished"));
  }
}
