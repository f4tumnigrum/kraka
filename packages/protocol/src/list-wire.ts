import * as v from "valibot";
import { AttentionFactsSchema, type AttentionFacts } from "./attention";
import {
  NativeRootSchema,
  ReceiptProofSchema,
  RoundPhaseSchema,
  type RoundPhase,
} from "./lifecycle";
import {
  ThreadSummarySchema,
  ListCountsSchema,
  ThreadLifecycleSchema,
  type ThreadSummary,
} from "./thread-list";
import { ThreadIdSchema } from "./ids";
import type { SubscriptionPage } from "./transport";

const [active, settled] = ThreadLifecycleSchema.entries.state.options;
const activeOrder = active.entries;
const activeDefaults = {
  kind: "active",
  pinnedAt: null,
  pinPosition: null,
  manualPosition: null,
  snoozedUntil: null,
} as const;
const listLifecycle = v.strictObject({
  archivedAt: v.optional(ThreadLifecycleSchema.entries.archivedAt, null),
  state: v.optional(
    v.variant("kind", [
      v.strictObject({
        ...activeOrder,
        pinnedAt: v.optional(activeOrder.pinnedAt, null),
        pinPosition: v.optional(activeOrder.pinPosition, null),
        manualPosition: v.optional(activeOrder.manualPosition, null),
        snoozedUntil: v.optional(activeOrder.snoozedUntil, null),
      }),
      settled,
    ]),
    () => ({ ...activeDefaults }),
  ),
});
const summary = ThreadSummarySchema.entries;
const listSummary = v.pipe(
  v.strictObject({
    ...summary,
    lastActivityAt: v.pipe(
      v.optional(summary.lastActivityAt),
      v.description("When absent, the last activity time equals createdAt in this summary."),
    ),
    parentThreadId: v.optional(summary.parentThreadId, null),
    lifecycle: listLifecycle,
    openTodos: v.optional(summary.openTodos, 0),
    activeRounds: v.optional(summary.activeRounds, 0),
  }),
  v.transform((row) => ({ ...row, lastActivityAt: row.lastActivityAt ?? row.createdAt })),
);
const counts = ListCountsSchema.entries;
const listCounts = v.strictObject({
  active: v.optional(counts.active, 0),
  pinned: v.optional(counts.pinned, 0),
  snoozed: v.optional(counts.snoozed, 0),
  settled: v.optional(counts.settled, 0),
  archived: v.optional(counts.archived, 0),
});

const source = AttentionFactsSchema.entries.root.entries,
  activity = source.rounds.item.entries;
const attempt = activity.round.entries.attempt.entries;
const [
  filed,
  armed,
  handed,
  recovering,
  uncertain,
  received,
  working,
  unobserved,
  closing,
  finished,
  endedEarly,
  notDelivered,
  handled,
  interrupted,
] = RoundPhaseSchema.options;
const observation = {
  root: v.strictObject({
    ...NativeRootSchema.entries,
    beganAt: v.optional(NativeRootSchema.entries.beganAt, null),
  }),
  receipt: v.optional(v.nullable(ReceiptProofSchema), null),
};
const [seenInput, seenRoot] = unobserved.entries.seen.options;
const phase = v.variant("kind", [
  filed,
  armed,
  handed,
  recovering,
  uncertain,
  received,
  v.strictObject({ ...working.entries, ...observation }),
  v.strictObject({
    ...unobserved.entries,
    seen: v.variant("kind", [seenInput, v.strictObject({ ...seenRoot.entries, ...observation })]),
  }),
  v.strictObject({ ...closing.entries, ...observation }),
  v.strictObject({ ...finished.entries, ...observation }),
  v.strictObject({ ...endedEarly.entries, ...observation }),
  handled,
  interrupted,
  v.strictObject({
    ...notDelivered.entries,
    lateReceipt: v.optional(notDelivered.entries.lateReceipt, null),
  }),
]);
const review = activity.review.wrapped.entries;
const listActivity = v.strictObject({
  ...activity,
  round: v.strictObject({
    ...activity.round.entries,
    attempt: v.strictObject({ ...attempt, phase }),
  }),
  quota: v.optional(
    v.nullable(
      v.strictObject({ resetAt: v.optional(activity.quota.wrapped.entries.resetAt, null) }),
    ),
    null,
  ),
  review: v.optional(
    v.nullable(
      v.strictObject({
        kind: v.optional(review.kind, "work"),
        deferredAtEnd: v.optional(review.deferredAtEnd, false),
      }),
    ),
    null,
  ),
});
const listSource = v.strictObject({
  ...source,
  readThrough: v.optional(source.readThrough, null),
  grouping: v.optional(source.grouping, "ordinary"),
  requests: v.optional(source.requests, () => []),
  rounds: v.optional(v.array(listActivity), () => []),
});
const listFacts = v.strictObject({
  ...AttentionFactsSchema.entries,
  root: listSource,
  descendants: v.optional(v.array(listSource), () => []),
});

const listThreadKey = v.strictObject({
  objectType: v.optional(v.literal("thread"), "thread"),
  id: ThreadIdSchema,
});
export const ListValueChangeSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("thread.summary"), summary: listSummary }),
  v.strictObject({ kind: v.literal("list.counts"), counts: listCounts }),
  v.strictObject({ kind: v.literal("window.enter"), key: listThreadKey }),
  v.strictObject({ kind: v.literal("window.leave"), key: listThreadKey }),
  v.strictObject({ kind: v.literal("attention.facts"), facts: listFacts }),
]);

function writeSummary(row: ThreadSummary): v.InferInput<typeof listSummary> {
  const { state, archivedAt } = row.lifecycle;
  const order =
    state.kind === "active"
      ? {
          kind: state.kind,
          pinnedAt: state.pinnedAt ?? undefined,
          pinPosition: state.pinPosition ?? undefined,
          manualPosition: state.manualPosition ?? undefined,
          snoozedUntil: state.snoozedUntil ?? undefined,
        }
      : state;
  const ordinary =
    state.kind === "active" &&
    state.pinnedAt === null &&
    state.pinPosition === null &&
    state.manualPosition === null &&
    state.snoozedUntil === null;
  return {
    ...row,
    lastActivityAt: row.lastActivityAt === row.createdAt ? undefined : row.lastActivityAt,
    parentThreadId: row.parentThreadId ?? undefined,
    openTodos: row.openTodos || undefined,
    activeRounds: row.activeRounds || undefined,
    lifecycle: { archivedAt: archivedAt ?? undefined, state: ordinary ? undefined : order },
  };
}
function writeObserved<
  T extends Pick<Extract<RoundPhase, { kind: "working" }>, "root" | "receipt">,
>(value: T) {
  return {
    ...value,
    root: { ...value.root, beganAt: value.root.beganAt ?? undefined },
    receipt: value.receipt ?? undefined,
  };
}
function writePhase(value: RoundPhase): v.InferInput<typeof phase> {
  switch (value.kind) {
    case "working":
    case "closing":
    case "finished":
    case "endedEarly":
      return writeObserved(value);
    case "unobserved":
      return value.seen.kind === "root" ? { ...value, seen: writeObserved(value.seen) } : value;
    case "notDelivered":
      return { ...value, lateReceipt: value.lateReceipt ?? undefined };
    default:
      return value;
  }
}
function writeSource(value: AttentionFacts["root"]): v.InferInput<typeof listSource> {
  return {
    ...value,
    grouping: value.grouping === "ordinary" ? undefined : value.grouping,
    readThrough: value.readThrough ?? undefined,
    requests: value.requests.length ? value.requests : undefined,
    rounds: value.rounds.length
      ? value.rounds.map((f) => ({
          ...f,
          round: {
            ...f.round,
            attempt: { ...f.round.attempt, phase: writePhase(f.round.attempt.phase) },
          },
          quota: f.quota ? { resetAt: f.quota.resetAt ?? undefined } : undefined,
          review: f.review
            ? {
                kind: f.review.kind === "work" ? undefined : f.review.kind,
                deferredAtEnd: f.review.deferredAtEnd || undefined,
              }
            : undefined,
        }))
      : undefined,
  };
}
export function listWireChange(change: SubscriptionPage["changes"][number]) {
  switch (change.kind) {
    case "window.enter":
    case "window.leave":
      return change.key.objectType === "thread"
        ? { kind: change.kind, key: { id: change.key.id } }
        : change;
    case "thread.summary":
      return { kind: change.kind, summary: writeSummary(change.summary) };
    case "list.counts": {
      const c = change.counts;
      return {
        kind: change.kind,
        counts: {
          active: c.active || undefined,
          pinned: c.pinned || undefined,
          snoozed: c.snoozed || undefined,
          settled: c.settled || undefined,
          archived: c.archived || undefined,
        },
      };
    }
    case "attention.facts": {
      const f = change.facts;
      return {
        kind: change.kind,
        facts: {
          ...f,
          root: writeSource(f.root),
          descendants: f.descendants.length ? f.descendants.map(writeSource) : undefined,
        },
      };
    }
    default:
      return change;
  }
}
export function subscriptionWirePage(page: SubscriptionPage) {
  return page.through.shapeVersion === 2 && page.through.scope.kind === "list"
    ? { ...page, changes: page.changes.map(listWireChange) }
    : page;
}
