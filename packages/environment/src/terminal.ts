import * as v from "valibot";
import {
  TerminalOffsetSchema,
  type ProcessIdentity,
  type TerminalControl,
  type EnvironmentSessionId,
  type PermissionItem,
  type TerminalAddress,
  type TerminalGeneration,
  type TerminalGrid,
  type TerminalGap,
  type TerminalOffset,
  type SubscriptionId,
  type TerminalSession,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";

/** Retain the most recent 8 MiB or 5,000 newline-delimited spans, whichever fits less. Replay begins at a safe sequence boundary. */
export const TERMINAL_HISTORY_LIMITS = { bytes: 8 * 1024 * 1024, lines: 5000 } as const;
const zero = v.parse(TerminalOffsetSchema, "0");
const offset = (value: bigint) => v.parse(TerminalOffsetSchema, String(value));

export function effectiveTerminalSize(
  viewers: readonly TerminalGrid[],
  fallback: TerminalGrid,
): TerminalGrid {
  const first = viewers[0];
  if (!first) return fallback;
  return viewers.reduce(
    (grid, viewer) => ({
      cols: Math.min(grid.cols, viewer.cols),
      rows: Math.min(grid.rows, viewer.rows),
    }),
    first,
  );
}

/** One table belongs to one authorized terminal generation. Detach removes exactly that viewer's grid. */
export function updateTerminalViewers(
  viewers: ReadonlyMap<SubscriptionId, TerminalGrid>,
  fallback: TerminalGrid,
  report:
    | { kind: "attach" | "resize"; viewer: SubscriptionId; grid: TerminalGrid }
    | { kind: "detach"; viewer: SubscriptionId },
) {
  const next = new Map(viewers);
  if (report.kind === "detach") next.delete(report.viewer);
  else if (report.kind === "attach" || next.has(report.viewer))
    next.set(report.viewer, report.grid);
  return { viewers: next, grid: effectiveTerminalSize([...next.values()], fallback) };
}

/** Only this viewer skips [sent, resume). The durable shell head can be further ahead. */
export function terminalGap(
  viewer: Pick<TerminalGap, "terminalId" | "generation" | "threadId" | "subscriptionId">,
  sent: TerminalOffset,
  resume: TerminalOffset,
  head: TerminalOffset,
): TerminalGap | null {
  const start = BigInt(sent),
    end = BigInt(resume);
  if (end > BigInt(head) || start > BigInt(head))
    throw new RangeError("Viewer range exceeds the committed terminal head");
  if (end <= start) return null;
  return {
    kind: "terminal.gap",
    terminalId: viewer.terminalId,
    threadId: viewer.threadId,
    generation: viewer.generation,
    subscriptionId: viewer.subscriptionId,
    from: sent,
    to: resume,
    missingBytes: offset(end - start),
    head,
  };
}

/** The environment process owns the Bun.Terminal handle; each new shell gets a fresh generation. */
export function startTerminal(address: TerminalAddress, grid: TerminalGrid): TerminalSession {
  return {
    threadId: address.threadId,
    terminalId: address.terminalId,
    generation: address.generation,
    kind: "starting",
    grid,
    head: zero,
    previous: null,
  };
}
export type TerminalEvent = { generation: TerminalGeneration } & (
  | { kind: "started"; process: ProcessIdentity }
  | { kind: "outputCommitted"; from: TerminalOffset; to: TerminalOffset }
  | { kind: "resized"; grid: TerminalGrid }
  | {
      kind: "exit";
      code: number | null;
      signal: string | null;
      reason: "shellExit" | "closed" | "environmentStopped";
    }
  | { kind: "processGone" }
  | { kind: "replace"; nextGeneration: TerminalGeneration; grid: TerminalGrid }
);
export function transitionTerminal(
  session: TerminalSession,
  event: TerminalEvent,
): TransitionResult<TerminalSession> {
  if (event.generation !== session.generation) return reject("wrongRequest");
  const { threadId, terminalId, generation, head, previous } = session;
  const address = { threadId, terminalId, generation, head, previous };
  switch (event.kind) {
    case "started":
      return session.kind === "starting"
        ? ok({ ...session, kind: "running", process: event.process })
        : reject("invalidState");
    case "outputCommitted":
      if (session.kind !== "running" || BigInt(event.to) <= BigInt(event.from))
        return reject("invalidState");
      if (BigInt(event.to) <= BigInt(head)) return ok(session);
      return event.from === head ? ok({ ...session, head: event.to }) : reject("invalidState");
    case "resized":
      return session.kind === "running"
        ? ok({ ...session, grid: event.grid })
        : reject("invalidState");
    case "exit":
      if (session.kind !== "running" && session.kind !== "starting") return reject("invalidState");
      return ok({
        ...address,
        kind: "exited",
        process: session.kind === "running" ? session.process : null,
        code: event.code,
        signal: event.signal,
        reason: event.reason,
      });
    case "processGone":
      if (session.kind === "lost") return ok(session);
      if (session.kind !== "running" && session.kind !== "starting") return reject("invalidState");
      return ok({
        ...address,
        kind: "lost",
        reason: "environmentRestart",
        process: session.kind === "running" ? session.process : null,
      });
    case "replace":
      if (
        (session.kind !== "lost" &&
          !(session.kind === "exited" && session.reason === "environmentStopped")) ||
        BigInt(event.nextGeneration) <= BigInt(generation)
      )
        return reject("invalidState");
      return ok({
        ...startTerminal({ ...address, generation: event.nextGeneration }, event.grid),
        previous: { generation, head, process: session.process, reason: "environmentRestart" },
      });
    default:
      return unexpected(event);
  }
}

/** Only an in-process environment session retains this handle. Journal generations outlive it. */
export type LiveTerminal = {
  session: Extract<TerminalSession, { kind: "running" }>;
  pty: Bun.Terminal;
};

export interface TerminalLogSegment {
  address: TerminalAddress;
  segment: string;
  from: TerminalOffset;
  to: TerminalOffset;
  newlineCount: number;
  digest: string;
}
export interface TerminalLogIndexEntry {
  segment: string;
  offset: TerminalOffset;
  fileByteOffset: number;
  cumulativeLines: number;
  safeReplayFrom: TerminalOffset;
  parserState: "text" | "escape" | "csi" | "osc" | "dcs" | "oscEscape" | "dcsEscape";
}
/** At reopen, load the tail page and follow earlier pages only as far as the retained safe boundary. */
export interface TerminalLogIndex {
  address: TerminalAddress;
  head: TerminalOffset;
  retainedFrom: TerminalOffset;
  tailPage: string | null;
}
export interface TerminalLogIndexPage {
  address: TerminalAddress;
  previousPage: string | null;
  from: TerminalOffset;
  to: TerminalOffset;
  segments: readonly TerminalLogSegment[];
  entries: readonly TerminalLogIndexEntry[];
}

/** Evaluate after resolving effective object rights. A read-only viewer cannot reuse another session's grant. */
export function acceptsTerminalInput(
  session: TerminalSession,
  owner: EnvironmentSessionId,
  rights: ReadonlySet<PermissionItem>,
  control: TerminalControl | null,
  request: Omit<TerminalControl, "environmentSessionId">,
): boolean {
  return (
    session.kind === "running" &&
    rights.has("term.input") &&
    control !== null &&
    control.environmentSessionId === owner &&
    control.lease === request.lease &&
    control.subscriptionId === request.subscriptionId &&
    control.terminalId === session.terminalId &&
    request.terminalId === session.terminalId &&
    control.threadId === session.threadId &&
    request.threadId === session.threadId &&
    control.generation === session.generation &&
    request.generation === session.generation
  );
}
