import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  HandoffContextSchema,
  HistoryCoverageSchema,
  ObjectChangeSchema,
  WorkRelationshipSchema,
} from "./index";

const partial = {
  coverage: "partial",
  missingSources: [
    {
      kind: "missingRound",
      environmentId: "environment",
      threadId: "ancestor",
      roundId: "missing",
    },
  ],
  omittedItems: 4,
};
test("partial handoff history identifies its missing ancestor even when no messages were collected", () => {
  const context = {
    transferId: "transfer",
    source: { environmentId: "environment", threadId: "source", roundId: "round" },
    messageIds: [],
    history: partial,
  };
  expect(v.parse(HandoffContextSchema, context).history.coverage).toBe("partial");
  expect(v.safeParse(HistoryCoverageSchema, { ...partial, missingSources: [] }).success).toBe(
    false,
  );
  expect(v.safeParse(HistoryCoverageSchema, { ...partial, coverage: "complete" }).success).toBe(
    false,
  );
  expect(v.safeParse(HistoryCoverageSchema, { ...partial, omittedItems: -1 }).success).toBe(false);
  expect(
    v.safeParse(HistoryCoverageSchema, {
      coverage: "complete",
      missingSources: [],
      omittedItems: 8,
    }).success,
  ).toBe(true);
});

test("older provider relationships retain unknown coverage and newer ones persist missing sources", () => {
  const relationship = {
    kind: "providerHandoff",
    threadId: "thread",
    sourceSessionId: "source",
    targetSessionId: "target",
    messageIds: [],
  };
  expect(v.parse(WorkRelationshipSchema, relationship)).not.toHaveProperty("history");
  expect(v.parse(HistoryCoverageSchema, { coverage: "unknown", omittedItems: null }).coverage).toBe(
    "unknown",
  );
  expect(v.parse(WorkRelationshipSchema, { ...relationship, history: partial })).toMatchObject({
    history: partial,
  });
});

test("text return results travel in command receipts and versioned subscription changes", () => {
  const result = {
    kind: "textReturned",
    transferId: "transfer",
    source: { environmentId: "environment", threadId: "child", roundId: "child-round" },
    target: { environmentId: "environment", threadId: "parent" },
    text: "The investigation identified the failing module.",
    history: partial,
    input: {
      messageId: "return-message",
      roundId: "parent-round",
      attemptId: "attempt",
      deliveryId: "delivery",
    },
  };
  expect(
    v.parse(CommandReceiptSchema, { kind: "accepted", commandId: "return", result }),
  ).toMatchObject({ result: { kind: "textReturned" } });
  expect(
    v.parse(ObjectChangeSchema, { kind: "handoff.textReturned", result, version: "2" }),
  ).toMatchObject({ version: "2", result: { history: partial } });
  expect(
    v.safeParse(CommandReceiptSchema, {
      kind: "accepted",
      commandId: "return",
      result: { ...result, filesMerged: true },
    }).success,
  ).toBe(false);
});
