import { expect, test } from "bun:test";
import { HistoryPageSchema } from "@kraka/protocol";
import * as v from "valibot";
import { decodeJournalRow, encodeJournalRow } from "./journal-row";

test("journal reads preserve the active attempt and the complete retry history", () => {
  const first = {
    attemptId: "first",
    deliveryId: "one",
    phase: { kind: "filed", gate: "eligible" },
  };
  const next = { ...first, attemptId: "next", deliveryId: "two" };
  const history = [
    { ...first, origin: { kind: "initial" } },
    { ...next, origin: { kind: "userResend", target: "first", commandId: "retry" } },
  ];
  for (const [attempt, attempts] of [
    [first, history],
    [next, history],
    [{ ...next, phase: { kind: "filed", gate: "held" } }, history],
    [first, undefined],
  ] as const) {
    const row = v.parse(HistoryPageSchema.entries.rows.item, {
      objectType: "round",
      value: {
        id: "r",
        threadId: "t",
        messageId: "m",
        place: "1",
        version: "3",
        attempt,
        ...(attempts && { attempts }),
      },
    });
    expect(decodeJournalRow(JSON.parse(JSON.stringify(row)))).toEqual(row);
    expect(decodeJournalRow(JSON.parse(encodeJournalRow(row)))).toEqual(row);
  }
});
