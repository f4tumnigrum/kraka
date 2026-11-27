import { HistoryPageSchema, RoundSchema, type HistoryRow } from "@kraka/protocol";
import * as v from "valibot";

const rowSchema = HistoryPageSchema.entries.rows.item;
const index = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const indexTag = v.object({ objectType: v.literal("round"), value: v.object({ attempt: index }) });
const indexedRound = v.strictObject({
  objectType: v.literal("round"),
  value: v.strictObject({ ...RoundSchema.entries, attempt: index }),
});

export function encodeJournalRow(row: HistoryRow) {
  if (row.objectType === "round" && row.value.attempts) {
    const current = row.value.attempt;
    const position = row.value.attempts.findIndex(({ origin: _origin, ...attempt }) =>
      Bun.deepEquals(attempt, current),
    );
    if (position >= 0)
      return JSON.stringify({ ...row, value: { ...row.value, attempt: position } });
  }
  return JSON.stringify(row);
}

export function decodeJournalRow(payload: unknown): HistoryRow {
  if (v.is(indexTag, payload)) {
    const { value } = v.parse(indexedRound, payload);
    const entry = value.attempts?.[value.attempt];
    if (!entry) throw Error("Missing indexed round attempt");
    const { origin: _origin, ...attempt } = entry;
    return { objectType: "round", value: { ...value, attempt } };
  }
  return v.parse(rowSchema, payload);
}
