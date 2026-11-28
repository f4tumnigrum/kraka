import { promoteSessionObservation } from "./session-observations";
import type {
  EnvironmentId,
  ObjectVersion,
  ThreadId,
  TimelineItemId,
  ToolActivityBody,
  RoundId,
  NativeObservationRelationship,
  ToolActivityFileChange,
  ToolActivityHistoryItem,
  ToolActivityReference,
} from "@kraka/protocol";
import {
  ToolActivityBodySchema,
  ExecutorSessionObservationSchema,
  type NativeRootTurnId,
} from "@kraka/protocol";
import type { AdapterEventEnvelope } from "./adapter-contract";
import { matchesAdapterEvent } from "./adapter-contract";
import type { ThreadSessionBinding } from "./executor-records";

import { TOOL_ACTIVITY_DETAIL_MINOR, ToolActivityHistoryItemSchema } from "@kraka/protocol";
import * as v from "valibot";
import type { ThreadJournal } from "./thread-journal";
import { visibleThreadRows, type AuthorizedScope } from "./thread-pass";

export type ToolActivityEvent = {
  threadId: ThreadId;
  roundId?: RoundId | undefined;
  instanceId: string;
  nativeSessionId: string;
  epoch: number;
  eventId: string;
  callId: string;
  attemptId: string;
  nativeRootTurnId: string;
  relationship?: NativeObservationRelationship;
  observation?: { sourceId: string; eventId: string };
  truncated?: boolean;
  reportedStatus?: "completed" | "failed";
  phase: "started" | "progress" | "ended";
  inputJson: string | null;
  outputText: string | null;
  exitCode: number | null;
  changes?: readonly ToolActivityFileChange[] | undefined;
  at: number;
};

export type ToolActivityActor = {
  environmentId: EnvironmentId;
  visibility: string;
  timelineItems: boolean;
  protocolMinor: number;
  allows: (threadId: ThreadId, permission: "thread.view") => boolean;
};

export type StoredToolActivityVersion = {
  item: ToolActivityHistoryItem;
  reference: ToolActivityReference;
  read: (offset: number, length: number) => Uint8Array;
};

export type ActivityRead =
  | { kind: "ready"; current: ToolActivityHistoryItem; version: StoredToolActivityVersion }
  | { kind: "expired"; current: ToolActivityHistoryItem; replacement: ToolActivityReference }
  | { kind: "unsupported" }
  | { kind: "notFound" };

function summary(text: string) {
  return text.slice(0, 240).replace(/[\uD800-\uDFFF]/gu, "�");
}
function inputSummary(inputJson: string | null) {
  if (inputJson === null) return null;
  const value: unknown = JSON.parse(inputJson);
  if (value && typeof value === "object" && !Array.isArray(value) && "command" in value)
    return typeof value.command === "string" ? summary(value.command) : summary(inputJson);
  return summary(inputJson);
}

function outputSummary(body: ToolActivityBody) {
  return body.output.kind === "unobserved" ? null : summary(body.output.text);
}

function nextPhase(
  current: ToolActivityHistoryItem["phase"] | null,
  next: ToolActivityEvent["phase"],
): ToolActivityHistoryItem["phase"] {
  if (current === "ended" || next === "ended") return "ended";
  if (current === "progress" || next === "progress") return "progress";
  return "started";
}

function updateBody(current: ToolActivityBody, event: ToolActivityEvent) {
  let input = current.input;
  if (event.inputJson !== null && input.kind === "unobserved")
    input = { kind: "captured", json: event.inputJson };

  let output = current.output;
  if (event.phase === "progress" && event.outputText !== null && output.kind !== "complete") {
    const text = (output.kind === "unobserved" ? "" : output.text) + event.outputText;
    output = { kind: "partial", text, truncated: false };
  }
  if (
    event.phase === "ended" &&
    event.outputText !== null &&
    event.truncated &&
    output.kind !== "complete"
  ) {
    const text =
      output.kind === "partial" && output.text.length > event.outputText.length
        ? output.text
        : event.outputText;
    output = { kind: "partial", text, truncated: true };
  } else if (event.phase === "ended" && event.outputText !== null) {
    if (output.kind === "unobserved") {
      output = { kind: "complete", text: event.outputText };
    } else if (event.outputText.startsWith(output.text)) {
      output = { kind: "complete", text: event.outputText };
    }
  }

  const exitCode =
    event.phase !== "ended"
      ? current.exitCode
      : current.status !== "completed" && current.status !== "failed"
        ? event.exitCode
        : current.exitCode;
  const status =
    event.phase !== "ended"
      ? current.status
      : exitCode === null
        ? (event.reportedStatus ?? "unknown")
        : exitCode === 0
          ? "completed"
          : "failed";
  const success =
    event.phase !== "ended"
      ? current.success
      : status === "completed"
        ? true
        : status === "failed"
          ? false
          : null;
  const changes = event.changes?.length
    ? [
        ...current.changes,
        ...event.changes.filter(
          (change) =>
            !current.changes.some((prior) => JSON.stringify(prior) === JSON.stringify(change)),
        ),
      ]
    : current.changes;
  return v.parse(ToolActivityBodySchema, {
    input,
    output,
    status,
    exitCode,
    success,
    fileCoverage: "unknown",
    changes,
  });
}

export function evolveToolActivity(
  current: { item: ToolActivityHistoryItem; body: ToolActivityBody } | null,
  event: ToolActivityEvent,
  identity: { id: TimelineItemId; createdPosition: string },
): { item: ToolActivityHistoryItem; body: ToolActivityBody; changed: boolean } {
  const source = current?.item.source ?? {
    instanceId: event.instanceId,
    nativeSessionId: event.nativeSessionId,
    epoch: event.epoch,
    eventId: event.eventId,
    sourceId: event.callId,
    callId: event.callId,
  };
  const priorBody =
    current?.body ??
    v.parse(ToolActivityBodySchema, {
      input: { kind: "unobserved" },
      output: { kind: "unobserved" },
      status: "running",
      exitCode: null,
      success: null,
      fileCoverage: "unknown",
      changes: [],
    });
  const body = updateBody(priorBody, event);
  const phase = nextPhase(current?.item.phase ?? null, event.phase);
  const input = inputSummary(body.input.kind === "captured" ? body.input.json : null);
  const output = outputSummary(body);
  const changed =
    !current ||
    phase !== current.item.phase ||
    input !== current.item.inputSummary ||
    output !== current.item.outputSummary ||
    JSON.stringify(body) !== JSON.stringify(current.body);
  if (!changed && current) return { ...current, changed: false };

  const item = {
    kind: "toolActivity" as const,
    id: current?.item.id ?? identity.id,
    threadId: event.threadId,
    source,
    assignment: {
      kind: "attempt" as const,
      attemptId: event.attemptId,
      relationship: event.relationship ?? {
        kind: "root" as const,
        nativeRootTurnId: event.nativeRootTurnId,
      },
    },
    phase,
    inputSummary: input,
    outputSummary: output,
    createdAt: current?.item.createdAt ?? event.at,
    createdPosition: current?.item.createdPosition ?? identity.createdPosition,
    version: current ? String(BigInt(current.item.version) + 1n) : "1",
  };
  return { item: v.parse(ToolActivityHistoryItemSchema, item), body, changed: true };
}

export function readActivity(options: {
  actor: ToolActivityActor;
  journal: ThreadJournal;
  threadId: ThreadId;
  itemId: TimelineItemId;
  expectedVersion: ObjectVersion | null;
}): ActivityRead {
  const { actor, journal, threadId, itemId, expectedVersion } = options;
  if (actor.environmentId !== journal.environmentId || !actor.allows(threadId, "thread.view"))
    return { kind: "notFound" };

  const scope: AuthorizedScope = {
    threadId,
    environmentId: actor.environmentId,
    canRead: (source) => actor.allows(source, "thread.view"),
    timelineItems: true,
    protocolMinor: actor.protocolMinor,
  };
  const view = journal.read(scope, actor.visibility);
  const found = visibleThreadRows(scope, view).rows.find(
    (entry) =>
      entry.row.objectType === "timelineItem" &&
      entry.row.value.kind === "toolActivity" &&
      entry.row.value.id === itemId,
  );
  if (found?.row.objectType !== "timelineItem" || found.row.value.kind !== "toolActivity")
    return { kind: "notFound" };
  if (!actor.allows(found.row.value.threadId, "thread.view")) return { kind: "notFound" };
  if (!actor.timelineItems || actor.protocolMinor < TOOL_ACTIVITY_DETAIL_MINOR)
    return { kind: "unsupported" };

  const current = found.row.value;
  const requested = expectedVersion ?? current.version;
  const version = journal.activityTransfer(current.threadId, current.id, requested);
  if (version) return { kind: "ready", current, version };
  const replacement = journal.activityTransfer(current.threadId, current.id, current.version);
  return replacement
    ? { kind: "expired", current, replacement: replacement.reference }
    : { kind: "notFound" };
}

export function recordAdapterActivity(
  journal: ThreadJournal,
  binding: ThreadSessionBinding,
  roundId: RoundId,
  event: AdapterEventEnvelope,
  root: NativeRootTurnId | null,
) {
  const p = event.payload;
  if (!matchesAdapterEvent(binding, event)) throw Error("Foreign activity handle");
  if (p.kind === "sessionObservationLinked") {
    if (p.attemptId !== binding.attemptId) throw Error("Foreign observation attempt");
    const source = {
      instanceId: event.instanceId,
      nativeSessionId: event.sessionId,
      epoch: event.epoch,
      ...p.observation,
    };
    return journal.saveObservation(binding.threadId, source, (prior) => {
      if (!prior) throw Error("Unknown observation source");
      const linked = promoteSessionObservation(prior, {
        kind: "attempt",
        source,
        attemptId: p.attemptId,
        relationship: p.relationship,
      });
      if (linked.kind !== "ok") throw Error(linked.reason);
      return linked.value;
    });
  }
  if (p.kind === "sessionObservation") {
    const { kind, sourceId, ...payload } = p;
    const source = {
      instanceId: event.instanceId,
      nativeSessionId: event.sessionId,
      epoch: event.epoch,
      eventId: event.eventId,
      sourceId,
    };
    return journal.saveObservation(binding.threadId, source, (prior) => {
      if (prior) {
        if (
          prior.category !== payload.category ||
          prior.redactedSummary !== payload.redactedSummary ||
          prior.observedAt !== payload.observedAt
        )
          throw Error("Conflicting session observation");
        return prior;
      }
      return v.parse(ExecutorSessionObservationSchema, {
        ...payload,
        kind: "executorObservation",
        id: crypto.randomUUID(),
        threadId: binding.threadId,
        source,
        createdPosition: journal.nextPosition(),
        version: "1",
        assignment: { kind: "session" },
      });
    });
  }
  if (p.kind !== "toolActivity" && p.kind !== "fileChanged") return;
  if (p.attemptId !== binding.attemptId) throw Error("Foreign activity attempt");
  if (p.kind === "fileChanged") {
    journal.recordUnattributedToolChange({
      ...(p.itemId ? { itemId: p.itemId } : {}),
      threadId: binding.threadId,
      attemptId: p.attemptId,
      eventId: JSON.stringify([event.instanceId, event.sessionId, event.epoch, event.eventId]),
      path: p.path,
      change: p.change,
      destination: p.destination,
      patch: p.patch,
    });
    return;
  }
  const relationship =
    p.relationship ?? (root && { kind: "root" as const, nativeRootTurnId: root });
  if (
    !relationship ||
    (relationship.kind === "root" && root && relationship.nativeRootTurnId !== root)
  )
    throw Error("Missing or conflicting native activity relationship");
  const out = v.safeParse(
    v.object({
      text: v.optional(v.nullable(v.string())),
      exitCode: v.optional(v.nullable(v.pipe(v.number(), v.safeInteger()))),
      status: v.optional(v.nullable(v.string())),
      truncated: v.optional(v.boolean()),
    }),
    p.output,
  );
  const fields = out.success ? out.output : null;
  const status = fields?.status;
  return journal.recordToolActivity({
    threadId: binding.threadId,
    roundId,
    instanceId: event.instanceId,
    nativeSessionId: event.sessionId,
    epoch: event.epoch,
    eventId: event.eventId,
    attemptId: p.attemptId,
    callId: p.callId,
    nativeRootTurnId: root ?? "",
    relationship,
    ...(p.observation ? { observation: p.observation } : {}),
    phase: p.phase,
    inputJson: p.input === null ? null : JSON.stringify(p.input),
    outputText:
      fields && "text" in fields
        ? (fields.text ?? null)
        : p.output === null
          ? null
          : typeof p.output === "string"
            ? p.output
            : JSON.stringify(p.output),
    exitCode: fields?.exitCode ?? null,
    truncated: fields?.truncated ?? false,
    ...(status === "failed" || status === "completed" ? { reportedStatus: status } : {}),
    changes: p.changes,
    at: Date.now(),
  });
}
