import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  TerminalGapSchema,
  TerminalAddressSchema,
  TerminalOffsetSchema,
  TerminalGenerationSchema,
  ContentTransferIdSchema,
  SubscriptionIdSchema,
} from "@kraka/protocol";
import { advanceTerminalCursor } from "../src";
const addr = v.parse(TerminalAddressSchema, {
  terminalId: "terminal",
  threadId: "thread",
  generation: "1",
});
const viewer = { ...addr, subscriptionId: v.parse(SubscriptionIdSchema, "viewer") };
const pos = (s: string) => v.parse(TerminalOffsetSchema, s);
const bytes = v.parse(ContentTransferIdSchema, "data");

test("the first live byte starts at the installed snapshot end, even above the safe integer range", () => {
  const from = pos("9007199254740993"),
    head = pos("9007199254740997");
  const start = { ...viewer, next: from };
  const snapshot = {
    ...viewer,
    kind: "terminal.snapshot" as const,
    from,
    head,
    retainedFrom: from,
    content: bytes,
  };
  const snap = advanceTerminalCursor(start, snapshot, 4n);
  if (snap.kind !== "ok") throw new Error("Expected the terminal cursor to advance");
  const output = {
    ...viewer,
    kind: "terminal.output" as const,
    from: head,
    to: pos("9007199254740999"),
    content: bytes,
  };
  const live = advanceTerminalCursor(snap.value, output, 2n);
  expect(live).toMatchObject({ kind: "ok", value: { next: output.to } });
  if (live.kind !== "ok") throw new Error("Expected the terminal cursor to advance");
  expect(advanceTerminalCursor(live.value, output, 2n)).toEqual({
    kind: "duplicate",
    value: live.value,
  });
  expect(advanceTerminalCursor(snap.value, output, 3n).kind).toBe("rejected");
  expect(advanceTerminalCursor(snap.value, { ...output, from: from }, 6n).kind).toBe("rejected");
  expect(
    advanceTerminalCursor(
      snap.value,
      { ...output, generation: v.parse(TerminalGenerationSchema, "2") },
      2n,
    ).kind,
  ).toBe("rejected");
});

test("reports precisely the skipped range for one viewer before replaying retained bytes", () => {
  const gap = v.parse(TerminalGapSchema, {
    ...viewer,
    kind: "terminal.gap",
    from: "10",
    to: "15",
    missingBytes: "5",
    head: "20",
  });
  if (!gap) throw new Error("Expected gap");
  expect(gap).toMatchObject({ from: "10", to: "15", missingBytes: "5", head: "20" });
  const cursor = { ...viewer, next: pos("10") };
  expect(advanceTerminalCursor(cursor, { ...gap, missingBytes: pos("4") }, 0n).kind).toBe(
    "rejected",
  );
  expect(
    advanceTerminalCursor(
      { ...cursor, subscriptionId: v.parse(SubscriptionIdSchema, "other") },
      gap,
      0n,
    ).kind,
  ).toBe("rejected");
  const skipped = advanceTerminalCursor(cursor, gap, 0n);
  if (skipped.kind !== "ok") throw new Error("Expected the terminal cursor to advance");
  expect(
    advanceTerminalCursor(
      skipped.value,
      {
        ...viewer,
        kind: "terminal.snapshot",
        retainedFrom: pos("15"),
        from: pos("15"),
        head: pos("20"),
        content: bytes,
      },
      5n,
    ),
  ).toMatchObject({ kind: "ok", value: { next: "20" } });
});
