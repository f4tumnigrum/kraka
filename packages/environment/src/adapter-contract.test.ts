import type { ModelCatalog } from "./executor-records";
import { describe, expect, test, expectTypeOf } from "bun:test";
import {
  ExecutorCapabilitiesSchema,
  ExecutorInstanceSnapshotSchema,
  ExecutorInstanceIdSchema,
  NativeSessionIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import {
  ADAPTER_FAMILIES,
  CAPABILITY_GROUPS,
  CAPABILITY_IDS,
  parseCapabilityMatrix,
  validateSessionFamily,
  matchesAdapterEvent,
  type AdapterEventEnvelope,
  type ProviderAdapter,
  type AdapterInstance,
  type ActionPermit,
  type InstanceServiceCommand,
  type CapabilitySupport,
} from "./adapter-contract";

describe("executor adapter contract", () => {
  test("names all 46 capability rows once and assigns each to a group", () => {
    expect(CAPABILITY_IDS).toHaveLength(46);
    expect(new Set(CAPABILITY_IDS).size).toBe(46);
    expect(Object.keys(CAPABILITY_GROUPS).sort()).toEqual([...CAPABILITY_IDS].sort());
    expect(new Set(Object.values(CAPABILITY_GROUPS)).size).toBe(6);
  });

  test("accepts a complete capability matrix and rejects a missing capability", () => {
    const value: CapabilitySupport = { kind: "native" };
    const matrix = Object.fromEntries(CAPABILITY_IDS.map((capability) => [capability, value]));
    const parsed = parseCapabilityMatrix(matrix);
    expect(parsed.kind).toBe("ok");
    if (parsed.kind === "ok") expect(Object.keys(parsed.value)).toHaveLength(46);

    const incomplete = { ...matrix };
    delete incomplete.configureEnvironment;
    expect(parseCapabilityMatrix(incomplete)).toEqual({
      kind: "rejected",
      reason: "invalidCapabilitySnapshot",
      message: null,
    });
    expect(
      parseCapabilityMatrix({
        ...matrix,
        configureEnvironment: { kind: "unsupported", reason: "" },
      }).kind,
    ).toBe("rejected");
  });

  test("rejects a native session binding from another adapter family", () => {
    const session = {
      family: "codex",
      instanceId: v.parse(ExecutorInstanceIdSchema, "codex-instance"),
      nativeSessionId: v.parse(NativeSessionIdSchema, "native-session"),
      epoch: 1,
    } as const;

    expect(validateSessionFamily("codex", session)).toEqual({ kind: "ok", value: undefined });
    expect(validateSessionFamily("acp", session)).toEqual({
      kind: "rejected",
      reason: "wrongFamily",
      message: null,
    });
  });

  test("declares each adapter family separately", () => {
    expect(ADAPTER_FAMILIES).toEqual([
      "codex",
      "claude-code",
      "opencode",
      "pi",
      "antigravity",
      "acp",
      "replay",
    ]);
  });
});

test("events from another instance or an earlier epoch cannot settle the current binding", () => {
  const sessionId = v.parse(NativeSessionIdSchema, "shared");
  const binding = {
    family: "replay",
    instanceId: v.parse(ExecutorInstanceIdSchema, "first"),
    epoch: 2,
    nativeSessionId: sessionId,
  } as const;
  const event: AdapterEventEnvelope<"replay"> = {
    family: binding.family,
    instanceId: binding.instanceId,
    epoch: binding.epoch,
    sessionId,
    eventId: "one",
    payload: { kind: "sessionLost", failure: { kind: "unknown", message: "disconnected" } },
  };
  expect(matchesAdapterEvent(binding, event)).toBe(true);
  expect(matchesAdapterEvent(binding, { ...event, epoch: 1 })).toBe(false);
  expect(
    matchesAdapterEvent(binding, {
      ...event,
      instanceId: v.parse(ExecutorInstanceIdSchema, "second"),
    }),
  ).toBe(false);
});
test("a fresh permission snapshot binds a supported selection and ceiling to the capability version", () => {
  const matrix = Object.fromEntries(CAPABILITY_IDS.map((k) => [k, { kind: "native" }]));
  const prior = { family: "replay", instanceId: "first", version: 1, checkedAt: 0, matrix };
  expect(v.safeParse(ExecutorCapabilitiesSchema, prior).success).toBe(true);
  expect(v.safeParse(ExecutorInstanceSnapshotSchema, prior).success).toBe(false);
  expect(
    v.safeParse(ExecutorInstanceSnapshotSchema, {
      ...prior,
      permission: { selected: "ask", ceiling: "edits" },
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(ExecutorInstanceSnapshotSchema, {
      ...prior,
      permission: { selected: "open", ceiling: "ask" },
    }).success,
  ).toBe(false);
});

// The compiler checks the same calls an unopened instance's service controller makes.
async function listBeforeOpen(
  driver: ProviderAdapter<"replay", object>,
  instance: AdapterInstance<"replay">,
  permit: ActionPermit<"replay", "listModels">,
  command: Extract<InstanceServiceCommand, { capability: "listModels" }>,
) {
  const reply = await driver.invoke(instance, permit, command);
  if (reply.kind === "ok") return reply.value.result.models;
  return [] as const;
}
type ListBeforeOpen = ReturnType<typeof listBeforeOpen>;
test("listing models before opening a coding session returns a typed catalog", () => {
  expectTypeOf<ListBeforeOpen>().toMatchTypeOf<Promise<ModelCatalog["models"]>>();
});
