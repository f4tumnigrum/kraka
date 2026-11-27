import {
  AttemptIdSchema,
  CaptureIdSchema,
  type CommandReceipt,
  type DeliveryId,
  DeliveryIdSchema,
  ExecutorInstanceIdSchema,
  ExecutorInstanceSnapshotSchema,
  type MessageId,
  MessageIdSchema,
  type ObjectVersion,
  QueuePositionSchema,
  type ReplayRunRequest,
  type ReplayTurnUpdate,
  ReplayTurnUpdateSchema,
  type Round,
  type RoundAttempt,
  RoundIdSchema,
  type Thread,
  ThreadSchema,
  validateReplayUpdate,
} from "@kraka/protocol";
import * as v from "valibot";
import {
  type AdapterEventEnvelope,
  type AdapterEventPayload,
  type AdapterInput,
  type CloseReason,
  type DeliveryGuarantee,
  matchesAdapterEvent,
  type ProviderAdapter,
} from "./adapter-contract";
import type { FrozenDelivery, ThreadSessionBinding } from "./executor-records";
import { type InputQueue, transitionInputQueue } from "./queue";
import type { TransitionResult } from "./result";
import { type RoundReport, transitionRound } from "./round";
import { recordAdapterActivity } from "./tool-activity";
import type { ThreadJournal } from "./thread-journal";

const instance = {
  family: "replay",
  instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
} as const;
const required = [
  "startSession",
  "submitTextInput",
  "streamResponse",
  "reportToolActivity",
  "reportRoundEnd",
  "selectPermissionMode",
] as const;
function applied<T>(result: TransitionResult<T>): T {
  if (result.kind === "rejected") throw new Error(result.reason);
  return result.value;
}
const toolCommand = v.strictObject({ command: v.string() });
const toolOutput = v.strictObject({ text: v.string() });
const toolEnd = v.strictObject({ text: v.string(), exitCode: v.pipe(v.number(), v.integer()) });

export type LiveSteer = (input: AdapterInput, deliveryId: DeliveryId) => Promise<void>;
export async function runReplayTurn<Handle extends object>({
  request,
  adapter,
  expectedText,
  modelId,
  workingDirectory,
  signal,
  persisted,
  emit,
}: {
  request: ReplayRunRequest;
  adapter: ProviderAdapter<"replay", Handle>;
  expectedText: string;
  modelId: string;
  workingDirectory: string;
  signal: AbortSignal;
  persisted?: {
    thread: Thread;
    round: Round;
    messageVersion: ObjectVersion;
    prepare: (
      delivery: FrozenDelivery,
      guarantee: DeliveryGuarantee,
    ) => { input: AdapterInput; handoff?: FrozenDelivery["handoff"] };
    report: (binding: ThreadSessionBinding, event: RoundReport) => void;
    steer?: (run: LiveSteer) => void;
    previousReceipt?: (event: AdapterEventEnvelope<"replay">) => void;
    readSteer?: (attempt: RoundAttempt["attemptId"], message: MessageId) => void;
    journal?: ThreadJournal;
    resume?: ThreadSessionBinding["nativeSessionId"];
    directory: () => string;
  };
  emit: (message: CommandReceipt | ReplayTurnUpdate) => void;
}): Promise<void> {
  const refuse = (kind: "unsupported" | "invalidState") =>
    emit({ kind: "rejected", commandId: request.commandId, failure: { kind } });
  signal.throwIfAborted();
  const capabilities = await adapter.capabilities(instance);
  signal.throwIfAborted();
  if (capabilities.kind !== "ok") return refuse("unsupported");
  const c = capabilities.value;
  const support = c.matrix.submitTextInput;
  if (
    c.family !== instance.family ||
    c.version !== 1 ||
    support.kind !== "native" ||
    required.some((id) => c.matrix[id].kind !== "native") ||
    ["configured", "installed", "authenticated", "model", "operation"].some(
      (k) => !Object.hasOwn(c.readiness, k),
    ) ||
    Object.values(c.readiness).some((r) => r.state !== "yes" || r.verifiedAt !== c.checkedAt) ||
    request.permission !== "ask" ||
    c.permission.modes.length !== 1 ||
    c.permission.modes[0] !== "ask" ||
    c.permission.enforcement !== "adapter" ||
    c.permission.changeEffective !== "now"
  )
    return refuse("unsupported");
  if (
    request.input.text !== expectedText ||
    request.input.references.length ||
    request.input.attachments.length
  )
    return refuse("invalidState");
  const snapshot = v.parse(ExecutorInstanceSnapshotSchema, {
    ...instance,
    version: c.version,
    checkedAt: c.checkedAt,
    matrix: c.matrix,
    permission: { ceiling: "ask", selected: "ask" },
  });
  const thread =
    persisted?.thread ??
    v.parse(ThreadSchema, {
      id: crypto.randomUUID(),
      projectId: "replay-project",
      worktreeId: null,
      title: request.input.text,
      lineage: { kind: "root" },
      version: "1",
      lifecycle: {
        archivedAt: null,
        state: {
          kind: "active",
          pinnedAt: null,
          pinPosition: null,
          manualPosition: null,
          snoozedUntil: null,
        },
      },
    });
  const messageId = persisted?.round.messageId ?? v.parse(MessageIdSchema, crypto.randomUUID());
  const roundId = persisted?.round.id ?? v.parse(RoundIdSchema, crypto.randomUUID());
  const attemptId =
    persisted?.round.attempt.attemptId ?? v.parse(AttemptIdSchema, crypto.randomUUID());
  const deliveryId =
    persisted?.round.attempt.deliveryId ?? v.parse(DeliveryIdSchema, crypto.randomUUID());
  const ticket = { attemptId, deliveryId };
  const ids = { roundId, attemptId };
  const queue: InputQueue = {
    threadId: thread.id,
    rows: [
      {
        id: roundId,
        messageId,
        place: v.parse(QueuePositionSchema, "1"),
        source: "person",
        attempt: { ...ticket, phase: { kind: "filed", gate: "eligible" } },
        previous: [],
      },
    ],
    decisions: [],
  };
  const opened = await adapter.open({
    instance,
    resume: persisted?.resume ?? null,
    attemptId,
    setup: {
      workingDirectory: persisted?.directory() ?? workingDirectory,
      additionalDirectories: [],
      environment: {},
      model: { id: modelId, options: {} },
      permission: snapshot.permission,
    },
  });
  if (opened.kind === "rejected") {
    signal.throwIfAborted();
    return refuse(opened.reason === "unsupported" ? "unsupported" : "invalidState");
  }
  const session = opened.value;
  let closing: Promise<void> | undefined;
  const release = (reason: CloseReason) =>
    (closing ??= Promise.resolve().then(async () => {
      const result = await adapter.close(session, reason);
      if (result.kind === "rejected") throw new Error(result.reason);
    }));
  const cancel = () => {
    void release("shutdown").catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let reason: CloseReason = "shutdown";
  let iterator: AsyncIterator<AdapterEventEnvelope<"replay">> | undefined;
  try {
    signal.throwIfAborted();
    if (
      session.family !== instance.family ||
      session.instanceId !== instance.instanceId ||
      !session.nativeSessionId ||
      session.epoch !== 1
    )
      return refuse("invalidState");
    const nativeSessionId = session.nativeSessionId;
    const binding: ThreadSessionBinding = {
      ...instance,
      nativeSessionId,
      epoch: session.epoch,
      threadId: thread.id,
      attemptId,
    };
    emit({
      kind: "accepted",
      commandId: request.commandId,
      result: { kind: "threadStarted", threadId: thread.id, messageId, ...ids, deliveryId },
    });
    signal.throwIfAborted();
    const head = applied(transitionInputQueue(queue, { kind: "claim", target: attemptId })).rows[0];
    if (!head) throw new Error("Claimed queue head missing");
    let attempt: RoundAttempt = head.attempt;
    const report = (event: RoundReport) => {
      attempt = { ...attempt, phase: applied(transitionRound(attempt, event)) };
      persisted?.report(binding, event);
    };
    const delivery: FrozenDelivery = {
      ...ticket,
      target: binding,
      messageVersion: persisted?.messageVersion ?? thread.version,
      input: { id: messageId, ...request.input },
      parts: [],
    };
    const payload = persisted?.prepare(delivery, c.input) ?? delivery;
    if (payload.handoff) {
      if (c.matrix.startSession.kind === "unsupported") throw Error("Handoff unsupported");
      const ack = await adapter.invoke(
        session,
        {
          ...instance,
          capability: "startSession",
          capabilityVersion: c.version,
          support: c.matrix.startSession,
        },
        {
          kind: "service",
          capability: "startSession",
          deliveryId,
          request: { kind: "handoff", ...payload.handoff },
        },
      );
      if (ack.kind !== "ok") throw Error("Frozen handoff rejected");
    }
    const steering = c.steering.insertCurrent;
    if (steering.support.kind !== "unsupported" && steering.accepts.includes("text")) {
      const steerSupport = steering.support;
      persisted?.steer?.(async (input, deliveryId) => {
        const ack = await adapter.invoke(
          session,
          {
            ...instance,
            capability: "steerCurrentRound",
            capabilityVersion: c.version,
            support: steerSupport,
          },
          {
            kind: "steer",
            capability: "steerCurrentRound",
            deliveryId,
            attemptId,
            mode: "insertCurrent",
            input,
          },
        );
        if (
          ack.kind !== "ok" ||
          ack.value.kind !== "written" ||
          ack.value.deliveryId !== deliveryId
        )
          throw Error("Steer write unconfirmed");
      });
    }
    iterator = adapter.events(session, null)[Symbol.asyncIterator]();
    const first = iterator.next().then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );
    const written = await adapter.invoke(
      session,
      { ...instance, capabilityVersion: snapshot.version, capability: "submitTextInput", support },
      { kind: "deliverInput", capability: "submitTextInput", ...ticket, input: payload.input },
    );
    signal.throwIfAborted();
    if (
      written.kind !== "ok" ||
      written.value.kind !== "written" ||
      written.value.deliveryId !== delivery.deliveryId
    )
      throw new Error("Replay delivery was not written");
    report({ kind: "written", ...ticket, at: snapshot.checkedAt });
    const seen = new Map<string, AdapterEventPayload>();
    const updates: ReplayTurnUpdate[] = [];
    const publish = (raw: ReplayTurnUpdate) => {
      const update = v.parse(ReplayTurnUpdateSchema, raw);
      validateReplayUpdate(ids, updates, update);
      emit(update);
      updates.push(update);
    };
    const consume = (event: AdapterEventEnvelope<"replay">) => {
      const p = event.payload;
      if (p.kind === "deliveryReceived" && p.attemptId !== attemptId && persisted) {
        persisted.previousReceipt?.(event);
        return;
      }
      if (
        !matchesAdapterEvent(binding, event) ||
        !("attemptId" in p) ||
        p.attemptId !== attemptId ||
        ("deliveryId" in p && p.deliveryId !== deliveryId)
      )
        throw new Error("Foreign replay event");
      const prior = seen.get(event.eventId);
      if (prior) {
        if (!Bun.deepEquals(prior, p)) throw new Error("Conflicting replay event ID");
        return;
      }
      switch (p.kind) {
        case "steerRead":
          persisted?.readSteer?.(p.attemptId, p.messageId);
          break;
        case "deliveryReceived":
          if (p.receipt.kind !== "input" || p.receipt.sessionId !== nativeSessionId)
            throw Error("Foreign native receipt");
          report({
            kind: "received",
            ...ticket,
            proof: { sessionId: nativeSessionId, itemId: p.receipt.itemId },
          });
          break;
        case "deliveryWritten":
          if (p.at !== snapshot.checkedAt) throw new Error("Conflicting replay write");
          break;
        case "roundStarted": {
          if (p.at !== snapshot.checkedAt) throw new Error("Conflicting replay start");
          const phase = attempt.phase;
          if (
            phase.kind === "working" &&
            phase.root.id === p.nativeRootTurnId &&
            phase.root.beganAt === p.at
          )
            break;
          report({
            kind: "rootStarted",
            ...ticket,
            root: { id: p.nativeRootTurnId, sessionId: nativeSessionId, beganAt: p.at },
          });
          publish({
            kind: "round.started",
            ...ids,
            nativeSessionId,
            nativeRootTurnId: p.nativeRootTurnId,
            startedAt: p.at,
            phase: "working",
            selectedMode: "ask",
            effectiveMode: "ask",
            supportedModes: ["ask"],
            enforcement: "adapter",
          });
          break;
        }
        case "toolActivity": {
          const { callId } = p;
          if (persisted?.journal) {
            const phase = attempt.phase;
            const result = recordAdapterActivity(
              persisted.journal,
              binding,
              roundId,
              event,
              "root" in phase ? (phase.root?.id ?? null) : null,
            );
            if (result === "conflict") throw Error("Conflicting replay tool event");
          }
          if (p.phase === "started")
            publish({
              kind: "tool.started",
              ...ids,
              callId,
              command: v.parse(toolCommand, p.input).command,
            });
          else if (p.phase === "progress")
            publish({
              kind: "tool.output",
              ...ids,
              callId,
              text: v.parse(toolOutput, p.output).text,
            });
          else {
            const out = v.parse(toolEnd, p.output);
            publish({
              kind: "tool.ended",
              ...ids,
              callId,
              exitCode: out.exitCode,
              output: out.text,
            });
          }
          break;
        }
        case "contentDelta": {
          if (p.role !== "assistant" || (p.finalText !== null && p.text !== ""))
            throw new Error("Unexpected assistant content");
          const fields = { ...ids, itemId: p.itemId, role: p.role };
          if (p.finalText === null)
            publish({ kind: "assistant.delta", ...fields, streaming: true, text: p.text });
          else publish({ kind: "assistant.final", ...fields, streaming: false, text: p.finalText });
          break;
        }
        case "roundEnded": {
          const phase = attempt.phase;
          if (
            (phase.kind !== "working" && phase.kind !== "closing") ||
            p.nativeRootTurnId !== phase.root.id ||
            phase.root.beganAt === null ||
            !Number.isSafeInteger(p.endedAt) ||
            p.endedAt < phase.root.beganAt ||
            p.outcome.reason !== "completed" ||
            p.endTimeEvidence.source !== "executorReported" ||
            p.endTimeEvidence.executorEndedAt !== p.endedAt ||
            p.endTimeEvidence.environmentObservedAt !== null
          )
            throw new Error("Conflicting native end evidence");
          if (phase.kind === "closing") {
            if (
              !persisted &&
              (p.endedAt !== phase.endedAt || p.outcome.nativeReason !== phase.nativeReason)
            )
              throw new Error("Native end changed");
            break;
          }
          const update = {
            kind: "round.ended",
            ...ids,
            nativeRootTurnId: p.nativeRootTurnId,
            endedAt: p.endedAt,
            outcome: p.outcome.reason,
            phase: "closing",
          } as const;
          validateReplayUpdate(ids, updates, update);
          report({
            kind: "rootEnded",
            ...ticket,
            root: phase.root,
            endedAt: p.endedAt,
            endTimeEvidence: p.endTimeEvidence,
            nativeReason: p.outcome.nativeReason,
            outcome: p.outcome.reason,
            captureId: v.parse(CaptureIdSchema, crypto.randomUUID()),
          });
          publish(update);
          break;
        }
        default:
          throw new Error("Unexpected replay fact");
      }
      seen.set(event.eventId, p);
    };
    const buffered = await first;
    if (!buffered.ok) throw buffered.error;
    let next = buffered.value;
    while (!next.done) {
      signal.throwIfAborted();
      consume(next.value);
      signal.throwIfAborted();
      next = await iterator.next();
    }
    signal.throwIfAborted();
    if (updates.at(-1)?.kind !== "round.ended") throw new Error("Incomplete replay");
    reason = "finished";
  } finally {
    signal.removeEventListener("abort", cancel);
    try {
      await release(reason);
    } finally {
      await iterator?.return?.();
    }
  }
}
