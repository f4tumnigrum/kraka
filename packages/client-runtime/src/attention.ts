import type {
  AttentionFacts,
  AttentionOccurrence,
  AttentionHint,
  AttentionThread,
  DeviceId,
  ReminderKey,
  ReminderRecord,
  SyncPosition,
} from "@kraka/protocol";

export type AttentionKind =
  | "approval"
  | "answer"
  | "failure"
  | "quota"
  | "unknown"
  | "wait"
  | "preparation"
  | "work"
  | "plan"
  | "check"
  | "ready";
export const ATTENTION_PRIORITY = {
  approval: 0,
  answer: 1,
  failure: 2,
  quota: 3,
  unknown: 4,
  wait: 5,
  preparation: 6,
  work: 7,
  plan: 8,
  check: 9,
  ready: 10,
} as const satisfies Record<AttentionKind, number>;

export interface AttentionCause {
  kind: AttentionKind;
  priority: number;
  needsHuman: boolean;
  key: ReminderKey;
  position: SyncPosition;
  reminder: AttentionHint | null;
  answerable?: boolean;
}
type ThreadFacts = AttentionFacts["root"];
type Activity = ThreadFacts["rounds"][number];

function roundKind(activity: Activity, unread: boolean, ordinary: boolean): AttentionKind {
  const phase = activity.round.attempt.phase;
  switch (phase.kind) {
    case "finished":
      return unread && ordinary && activity.review && !activity.review.deferredAtEnd
        ? activity.review.kind === "plan"
          ? "plan"
          : "check"
        : "ready";
    case "endedEarly":
      if (phase.reason === "unknown") return "unknown";
      return (phase.reason === "failed" || phase.reason === "lost") && unread ? "failure" : "ready";
    case "notDelivered":
      return "ready";
    default:
      if (activity.quota) return "quota";
      switch (phase.kind) {
        case "unobserved":
        case "uncertain":
          return "unknown";
        case "recovering":
          return phase.action === "inspectInput" ? "unknown" : "preparation";
        case "filed":
        case "armed":
          return "preparation";
        case "received":
        case "handed":
          return "wait";
        case "working":
        case "closing":
          return "work";
        default: {
          const unhandled: never = phase;
          throw new Error(String(unhandled));
        }
      }
  }
}

/** Stable across windows, installation restarts and identifiers containing separators. The device scopes its own ledger. */
export function reminderKeyId(key: ReminderKey): string {
  const o = key.object;
  return JSON.stringify([
    key.ownerId,
    key.environmentId,
    key.databaseGeneration,
    key.threadId,
    o.kind,
    ...(o.kind === "request" ? [o.requestId] : [o.roundId, o.attemptId]),
  ]);
}

function makeCause(
  kind: AttentionKind,
  key: ReminderKey,
  position: SyncPosition,
  reminder: AttentionHint | null,
): AttentionCause {
  return {
    kind,
    priority: ATTENTION_PRIORITY[kind],
    needsHuman:
      kind === "approval" ||
      kind === "answer" ||
      kind === "unknown" ||
      kind === "failure" ||
      kind === "quota" ||
      kind === "plan" ||
      kind === "check",
    key,
    position,
    reminder,
  };
}

function compareText(a: string, b: string): number {
  const right = b[Symbol.iterator]();
  for (const ch of a) {
    const next = right.next();
    if (next.done) return 1;
    const diff = (ch.codePointAt(0) ?? 0) - (next.value.codePointAt(0) ?? 0);
    if (diff) return diff;
  }
  return right.next().done ? 0 : -1;
}
function compareCause(a: AttentionCause, b: AttentionCause): number {
  if (a.priority !== b.priority) return a.priority - b.priority;
  const x = BigInt(a.position),
    y = BigInt(b.position);
  if (x !== y) return x < y ? -1 : 1;
  const thread = compareText(a.key.threadId, b.key.threadId);
  if (thread) return thread;
  const left = a.key.object,
    right = b.key.object;
  if (left.kind === "request")
    return right.kind === "request" ? compareText(left.requestId, right.requestId) : -1;
  if (right.kind === "request") return 1;
  return compareText(left.roundId, right.roundId) || compareText(left.attemptId, right.attemptId);
}

function roundReminder(
  kind: AttentionKind,
  key: Extract<AttentionHint, { kind: "roundFailed" | "roundCompleted" }>["key"],
): AttentionHint | null {
  if (kind === "failure") return { kind: "roundFailed", key };
  if (kind === "check" || kind === "plan") return { kind: "roundCompleted", key };
  return null;
}
/** Call with one installed, authorized fact set. Visible-thread state never changes the list or its order. */
export function interpretAttention(facts: AttentionFacts) {
  const causes: AttentionCause[] = [];
  const visited = new Set<ThreadFacts["threadId"]>();
  for (const thread of [facts.root, ...facts.descendants]) {
    if (visited.has(thread.threadId)) continue;
    visited.add(thread.threadId);
    const scope = {
      ownerId: facts.ownerId,
      environmentId: facts.environmentId,
      databaseGeneration: facts.databaseGeneration,
      threadId: thread.threadId,
    };
    for (const { request, openedAt, answerable } of thread.requests) {
      if (request.state.kind !== "open") continue;
      const key = { ...scope, object: { kind: "request" as const, requestId: request.id } };
      const hint = { kind: request.body.kind, key };
      causes.push({
        ...makeCause(request.body.kind === "approval" ? "approval" : "answer", key, openedAt, hint),
        answerable: answerable === true,
      });
    }
    for (const activity of thread.rounds) {
      const key = {
        ...scope,
        object: {
          kind: "round" as const,
          roundId: activity.round.id,
          attemptId: activity.round.attempt.attemptId,
        },
      };
      const unread =
        thread.readThrough === null || BigInt(activity.changedAt) > BigInt(thread.readThrough);
      const kind = roundKind(activity, unread, thread.grouping === "ordinary");
      const reminder = roundReminder(kind, key);
      const cause = makeCause(kind, key, activity.changedAt, reminder);
      const phase = activity.round.attempt.phase;
      const held = (phase.kind === "filed" || phase.kind === "recovering") && phase.gate === "held";
      causes.push({ ...cause, needsHuman: cause.needsHuman || held });
    }
  }
  causes.sort(compareCause);
  return {
    first: causes[0] ?? {
      kind: "ready" as const,
      priority: ATTENTION_PRIORITY.ready,
      needsHuman: false,
      key: null,
      position: null,
      reminder: null,
    },
    causes,
    needsHuman: causes.some((c) => c.needsHuman),
    open: causes.filter((c) => c.key.object.kind === "request"),
  };
}

/** On first enable, include all still-open requests and leave older completed attempts in the list only. */
export function currentReminders(
  reading: ReturnType<typeof interpretAttention>,
  enabledAt: SyncPosition,
): AttentionHint[] {
  return reading.causes.flatMap((c) =>
    c.reminder && (c.key.object.kind === "request" || BigInt(c.position) > BigInt(enabledAt))
      ? [c.reminder]
      : [],
  );
}

/** Catch-up reads retain already closed requests. Opening their hint shows their recorded outcome. */
export function reminderForOccurrence(
  scope: Omit<AttentionThread, "threadId">,
  occurrence: AttentionOccurrence,
): AttentionHint | null {
  const address = {
    ownerId: scope.ownerId,
    environmentId: scope.environmentId,
    databaseGeneration: scope.databaseGeneration,
    threadId: occurrence.threadId,
  };
  if (occurrence.kind === "requestOpened") {
    return {
      kind: occurrence.request.body.kind,
      key: { ...address, object: { kind: "request", requestId: occurrence.request.id } },
    };
  }
  const phase = occurrence.round.attempt.phase;
  if (phase.kind !== "finished" && phase.kind !== "endedEarly") return null;
  const reading = roundKind(
    occurrence,
    occurrence.readThrough === null ||
      BigInt(occurrence.changedAt) > BigInt(occurrence.readThrough),
    occurrence.grouping === "ordinary",
  );
  return roundReminder(reading, {
    ...address,
    object: {
      kind: "round",
      roundId: occurrence.round.id,
      attemptId: occurrence.round.attempt.attemptId,
    },
  });
}

export type ReminderClaim = { record: ReminderRecord; present: boolean };

/** The device writer commits the record before presenting. Replaying any recorded state cannot grant presentation again. */
export function claimReminder(
  deviceId: DeviceId,
  hint: AttentionHint,
  visible: AttentionThread | null,
  previous: ReminderRecord | null,
): ReminderClaim {
  const key = hint.key;
  if (previous) {
    if (previous.deviceId !== deviceId || reminderKeyId(key) !== reminderKeyId(previous.key))
      throw new Error("Reminder record belongs to a different device or object");
    return { record: previous, present: false };
  }
  const quiet =
    visible !== null &&
    visible.ownerId === key.ownerId &&
    visible.environmentId === key.environmentId &&
    visible.databaseGeneration === key.databaseGeneration &&
    visible.threadId === key.threadId;
  return { record: { deviceId, key, state: quiet ? "suppressed" : "claimed" }, present: !quiet };
}

export function updateReminder(
  record: ReminderRecord,
  event: "confirmed" | "receiptLost" | "closed",
): ReminderRecord {
  switch (event) {
    case "closed":
      return { ...record, state: "withdrawn" };
    case "receiptLost":
      return record.state === "claimed" ? { ...record, state: "unconfirmed" } : record;
    case "confirmed":
      return record.state === "claimed" || record.state === "unconfirmed"
        ? { ...record, state: "posted" }
        : record;
  }
}

/** All windows on a device share this transaction. Only its committed winner may call NotificationHost.show. */
export interface ReminderLedger {
  claim(hint: AttentionHint, visible: AttentionThread | null): Promise<ReminderClaim>;
  update(key: ReminderKey, event: "confirmed" | "receiptLost" | "closed"): Promise<void>;
}
