import type {
  TerminalOffset,
  TerminalGap,
  TerminalSnapshot,
  TerminalOutput,
} from "@kraka/protocol";

export type TerminalCursor = Pick<
  TerminalGap,
  "threadId" | "terminalId" | "generation" | "subscriptionId"
> & { next: TerminalOffset };
export type TerminalCursorResult =
  | { kind: "ok" | "duplicate"; value: TerminalCursor }
  | { kind: "rejected"; reason: "invalidState" | "wrongRequest" };

/** Install the snapshot once fully received. A duplicate live block may be ignored, but a partial overlap needs reattachment. */
export function advanceTerminalCursor(
  cursor: TerminalCursor,
  block: TerminalSnapshot | TerminalOutput | TerminalGap,
  receivedBytes: bigint,
): TerminalCursorResult {
  if (
    cursor.threadId !== block.threadId ||
    cursor.terminalId !== block.terminalId ||
    cursor.generation !== block.generation ||
    cursor.subscriptionId !== block.subscriptionId
  )
    return { kind: "rejected", reason: "wrongRequest" };
  if (block.kind === "terminal.gap") {
    const count = BigInt(block.to) - BigInt(block.from);
    if (
      receivedBytes !== 0n ||
      count <= 0n ||
      count !== BigInt(block.missingBytes) ||
      BigInt(block.to) > BigInt(block.head)
    )
      return { kind: "rejected", reason: "invalidState" };
    if (BigInt(block.to) <= BigInt(cursor.next)) return { kind: "duplicate", value: cursor };
    return block.from === cursor.next
      ? { kind: "ok", value: { ...cursor, next: block.to } }
      : { kind: "rejected", reason: "invalidState" };
  }
  const next = block.kind === "terminal.snapshot" ? block.head : block.to;
  const from = BigInt(block.from),
    to = BigInt(next),
    expected = BigInt(cursor.next);
  if (receivedBytes < 0n || to - from !== receivedBytes)
    return { kind: "rejected", reason: "invalidState" };
  if (block.kind === "terminal.snapshot") {
    if (
      BigInt(block.retainedFrom) > from ||
      from > expected ||
      to < expected ||
      (block.content === null) !== (receivedBytes === 0n)
    )
      return { kind: "rejected", reason: "invalidState" };
  } else {
    if (receivedBytes === 0n) return { kind: "rejected", reason: "invalidState" };
    if (to <= expected) return { kind: "duplicate", value: cursor };
    if (from !== expected) return { kind: "rejected", reason: "invalidState" };
  }
  return { kind: "ok", value: { ...cursor, next } };
}
