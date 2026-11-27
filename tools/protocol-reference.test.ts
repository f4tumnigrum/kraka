import { describe, expect, test } from "bun:test";
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
