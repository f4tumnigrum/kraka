import type { ThreadLifecycle, ThreadChange } from "@kraka/protocol";

/** The caller has already checked idle time or PR evidence and other blockers at this row version. */
export function settleThread(
  current: ThreadLifecycle,
  reason: "idle" | "merged" | "closed" | "manual",
  at: number,
): ThreadLifecycle {
  if (
    current.state.kind === "settled" ||
    (reason !== "manual" && (current.state.pinnedAt !== null || current.archivedAt !== null))
  )
    return current;
  return { ...current, state: { kind: "settled", reason, at } };
}

/** Version and snooze blockers are resolved against the same thread row the writer will conditionally replace. */
export function changeThreadLifecycle(
  current: ThreadLifecycle,
  change: ThreadChange,
  now: number,
  snoozeBlocked: boolean,
): ThreadLifecycle | null {
  switch (change.kind) {
    case "archive":
      return { ...current, archivedAt: current.archivedAt ?? now };
    case "unarchive":
      return { ...current, archivedAt: null };
    case "settle":
      return settleThread(current, "manual", now);
    case "reopen":
      return current.state.kind === "active"
        ? current
        : {
            ...current,
            state: {
              kind: "active",
              pinnedAt: null,
              pinPosition: null,
              manualPosition: null,
              snoozedUntil: null,
            },
          };
  }
  if (current.state.kind !== "active") return null;
  const state = current.state;
  switch (change.kind) {
    case "pin":
      return {
        ...current,
        state: { ...state, pinnedAt: state.pinnedAt ?? now, pinPosition: change.position },
      };
    case "unpin":
      return { ...current, state: { ...state, pinnedAt: null, pinPosition: null } };
    case "order":
      return { ...current, state: { ...state, manualPosition: change.position } };
    case "wake":
      return { ...current, state: { ...state, snoozedUntil: null } };
    case "snooze":
      return change.until > now && !snoozeBlocked
        ? { ...current, state: { ...state, snoozedUntil: change.until } }
        : null;
  }
}
