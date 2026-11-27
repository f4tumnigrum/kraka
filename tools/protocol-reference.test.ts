import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { validateNamed } from "./reference-client";
import { sampleRequest } from "./fixtures/replay-process";
import * as v from "valibot";
import { protocolSchemas, REQUEST_METHODS } from "@kraka/protocol";
import { findStaleReferenceFiles, generateProtocolReference } from "./protocol-reference";

describe("protocol reference generation", () => {
  test("generates byte-identical files from equivalent schema sources", () => {
    const first = generateProtocolReference({
      Ready: v.literal("ready"),
      Sample: v.strictObject({
        count: v.pipe(v.number(), v.integer(), v.minValue(0)),
        name: v.string(),
      }),
    });
    const second = generateProtocolReference({
      Sample: v.strictObject({
        count: v.pipe(v.number(), v.integer(), v.minValue(0)),
        name: v.string(),
      }),
      Ready: v.literal("ready"),
    });

    expect(first).toEqual(second);
  });

  test("marks generated files stale when the schema source changes", () => {
    const existing = generateProtocolReference({
      Sample: v.object({ name: v.string() }),
    });
    const updated = generateProtocolReference({
      Sample: v.object({
        count: v.number(),
        name: v.string(),
      }),
    });

    expect(findStaleReferenceFiles(updated, existing)).toEqual([
      "index.md",
      "protocol.schema.json",
    ]);
  });

  test("fails when a Valibot schema cannot be represented in JSON Schema", () => {
    expect(() => generateProtocolReference({ Upload: v.file() })).toThrow();
  });

  test("exports separate named definitions for environment, thread, round and native session IDs", () => {
    const files = generateProtocolReference(protocolSchemas);
    const document = JSON.parse(files["protocol.schema.json"] ?? "{}") as {
      $defs: Record<string, unknown>;
    };

    expect(document.$defs).toHaveProperty("EnvironmentId");
    expect(document.$defs).toHaveProperty("ThreadId");
    expect(document.$defs).toHaveProperty("RoundId");
    expect(document.$defs).toHaveProperty("NativeSessionId");
    expect(files["protocol.schema.json"]).toContain('"$ref": "#/$defs/ThreadId"');
  });

  test("prints each request method with its required permission", () => {
    const files = generateProtocolReference(protocolSchemas, Object.values(REQUEST_METHODS));

    expect(files["index.md"]).toContain("| `round.stop` | `thread.send` | thread |");
    expect(files["index.md"]).toContain("| `todo.answer` | `thread.reply` | thread |");
    expect(files["index.md"]).toContain("| `device.pairing.approve` | `access.give` | project |");
    expect(files["protocol.schema.json"]).toContain("Requires thread.send");
  });

  test("publishes compact and clear as separate signed thread methods", () => {
    const files = generateProtocolReference(protocolSchemas, Object.values(REQUEST_METHODS));
    expect(files["index.md"]).toContain("| `thread.compact` | `thread.send` | thread |");
    expect(files["index.md"]).toContain("| `thread.clear` | `thread.send` | thread |");
    expect(files["index.md"]).toContain("## ToolActivityHistoryItem");
    expect(files["index.md"]).toContain("## WorktreeLocation");
  });
});

const document = await Bun.file(
  resolve(import.meta.dir, "../docs/generated/protocol/protocol.schema.json"),
).json();

describe("published Draft 2020-12 definitions", () => {
  test("an empty object fails the selected receipt definition", () => {
    expect(validateNamed(document, "CommandReceipt", {})).toBe(false);
    expect(
      validateNamed(document, "CommandReceipt", {
        kind: "rejected",
        commandId: "run-1",
        failure: { kind: "unsupported" },
      }),
    ).toBe(true);
  });

  test("unknown request fields survive parsing and are rejected", () => {
    const request = JSON.parse(JSON.stringify({ ...sampleRequest, extra: true }));
    expect(validateNamed(document, "ReplayRunRequest", sampleRequest)).toBe(true);
    expect(validateNamed(document, "ReplayRunRequest", request)).toBe(false);
    expect(request).toHaveProperty("extra", true);
  });

  test("text return receipts and updates require a source for partial history", () => {
    const source = { environmentId: "env", threadId: "source", roundId: "source-round" };
    const result = {
      kind: "textReturned",
      transferId: "transfer",
      source,
      target: { environmentId: "env", threadId: "target" },
      text: "Found the marker.",
      history: {
        coverage: "partial",
        missingSources: [{ kind: "missingRound", ...source }],
        omittedItems: 2,
      },
      input: { messageId: "input", roundId: "round", attemptId: "attempt", deliveryId: "delivery" },
    };
    const receipt = { kind: "accepted", commandId: "return", result };
    const update = { kind: "handoff.textReturned", version: "2", result };
    expect(validateNamed(document, "CommandReceipt", receipt)).toBe(true);
    expect(validateNamed(document, "ObjectChange", update)).toBe(true);
    const incomplete = { ...result, history: { ...result.history, missingSources: [] } };
    expect(validateNamed(document, "CommandReceipt", { ...receipt, result: incomplete })).toBe(
      false,
    );
    expect(validateNamed(document, "ObjectChange", { ...update, result: incomplete })).toBe(false);
    expect(
      validateNamed(document, "HistoryCoverage", {
        coverage: "complete",
        missingSources: [],
        omittedItems: 0,
      }),
    ).toBe(true);
    expect(
      validateNamed(document, "HistoryCoverage", { ...result.history, coverage: "complete" }),
    ).toBe(false);
  });

  test("round end time evidence retains its source and historical unknown times", () => {
    const unknown = { source: "unknown", executorEndedAt: null, environmentObservedAt: null };
    for (const sample of [
      { ...unknown, source: "executorReported", executorEndedAt: 10 },
      { ...unknown, source: "environmentObserved", environmentObservedAt: 15 },
      unknown,
    ])
      expect(validateNamed(document, "RoundEndTimeEvidence", sample)).toBe(true);
    for (const field of ["executorEndedAt", "environmentObservedAt"]) {
      expect(validateNamed(document, "RoundEndTimeEvidence", { ...unknown, [field]: 10 })).toBe(
        false,
      );
    }
  });
});
