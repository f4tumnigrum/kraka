import { describe, expect, test } from "bun:test";
import { basename, dirname, join } from "node:path";
import { parseExecutorSample, type ExecutorFrame, type ExecutorHeader } from "./fixtures/executor";
import { parseScenario } from "./fixtures/scenario";
import * as v from "valibot";
import { ReplayFactSchema } from "./fixtures/scenario";

const root = join(import.meta.dir, "../fixtures");
const executorDir = join(root, "executors");
const scenarioDir = join(root, "scenarios");
const executorFiles = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: executorDir })].sort();
const scenarioFiles = [...new Bun.Glob("*.json").scanSync({ cwd: scenarioDir })].sort();
test("older replay endings retain unknown clock provenance while newer facts preserve both times", () => {
  const fact = {
    family: "replay",
    instanceId: "replay",
    sessionId: "native",
    epoch: 1,
    eventId: "end",
    payload: {
      kind: "roundEnded",
      attemptId: "attempt",
      nativeRootTurnId: "root",
      endedAt: 100,
      outcome: { reason: "completed", nativeReason: null },
    },
  };
  expect(v.parse(ReplayFactSchema, fact)).toMatchObject({
    payload: {
      endTimeEvidence: {
        source: "unknown",
        executorEndedAt: null,
        environmentObservedAt: null,
      },
    },
  });
  const evidence = { source: "executorReported", executorEndedAt: 100, environmentObservedAt: 120 };
  expect(
    v.parse(ReplayFactSchema, { ...fact, payload: { ...fact.payload, endTimeEvidence: evidence } }),
  ).toMatchObject({ payload: { endTimeEvidence: evidence } });
});
describe("checked-in replay data", () => {
  test("includes the replay probe and each user scenario", () => {
    expect(executorFiles).toContain("replay/echoes-a-host-probe.jsonl");
    for (const name of [
      "first-answer-wins",
      "reconnect-only-replaces-changed-objects",
      "checkpoint-finishes-after-the-round-ends",
      "human-queue-waits-for-release-after-restart",
      "dropping-an-unknown-input-keeps-its-late-receipt",
      "a-slow-subscription-does-not-stall-its-neighbor",
      "two-environments-report-setting-support-separately",
      "a-lagging-terminal-viewer-gets-an-exact-byte-gap",
    ])
      expect(scenarioFiles).toContain(`${name}.json`);
  });
  for (const file of executorFiles) {
    test(file, async () => {
      const sample = parseExecutorSample(await Bun.file(join(executorDir, file)).text());
      expect(dirname(file)).toBe(sample.header.family);
    });
  }
  for (const file of scenarioFiles) {
    test(file, async () => {
      const raw: unknown = await Bun.file(join(scenarioDir, file)).json();
      expect(parseScenario(raw).name).toBe(basename(file, ".json"));
    });
  }
});

const header: ExecutorHeader = {
  kind: "header",
  family: "replay",
  protocol: "probe/1",
  sourceRevision: "1.0",
  scenario: "echo",
  description: "Replay echoes the probe.",
};
const frame: ExecutorFrame = {
  kind: "frame",
  seq: 1,
  direction: "toExecutor",
  channel: "stdio",
  frame: null,
};
const jsonl = (...rows: unknown[]) => rows.map((row) => JSON.stringify(row)).join("\n");
describe("executor JSONL", () => {
  test("preserves opaque native JSON on every channel and in either direction", () => {
    const channels = ["stdio", "http", "sse", "sdk"] as const;
    const frames = channels.map(
      (channel, i): ExecutorFrame => ({
        ...frame,
        channel,
        seq: i + 1,
        direction: i % 2 ? "fromExecutor" : "toExecutor",
        frame: [null, {}, { "native-id": 11 }, false],
      }),
    );
    expect(parseExecutorSample(`${jsonl(header, ...frames).replaceAll("\n", "\r\n")}\r\n`)).toEqual(
      { header, frames },
    );
  });
  test("requires exactly one header before any frames", () => {
    for (const rows of [
      [header],
      [frame, header],
      [header, frame, header],
      [{ ...header, family: "other" }, frame],
    ])
      expect(() => parseExecutorSample(jsonl(...rows))).toThrow();
  });
  test("requires contiguous sequence numbers beginning at one", () => {
    for (const sequence of [[0], [2], [1, 3], [1, 1], [1, 2, 1]]) {
      expect(() =>
        parseExecutorSample(jsonl(header, ...sequence.map((seq) => ({ ...frame, seq })))),
      ).toThrow();
    }
  });
  test("rejects unknown directions, channels and missing native frames", () => {
    const { frame: native, ...withoutNative } = frame;
    expect(parseExecutorSample(jsonl(header, frame)).frames[0]?.frame).toBe(native);
    for (const invalid of [
      { ...frame, direction: "both" },
      { ...frame, channel: "file" },
      withoutNative,
    ]) {
      expect(() => parseExecutorSample(jsonl(header, invalid))).toThrow();
    }
  });
  test("reports malformed JSON and blank rows by line", () => {
    expect(() => parseExecutorSample(`${JSON.stringify(header)}\n{"secret": oops}`)).toThrow(
      "Invalid JSON at line 2",
    );
    expect(() =>
      parseExecutorSample(`${JSON.stringify(header)}\n\n${JSON.stringify(frame)}`),
    ).toThrow("Empty JSONL row at line 2");
  });
  test("checks nested credentials and individual tokens embedded in free text", () => {
    const providerToken = `ghp_${"x".repeat(20)}`;
    for (const native of [
      { headers: { "X-Api-Key": "unmarked" } },
      { access_token: { parts: ["fake-first", "unmarked"] } },
      { text: "fake note followed by Bearer unmarked" },
      { headers: { Authorization: "Bearer fake-test, Basic unmarked" } },
      { url: "https://test.invalid/?api_key=unmarked&note=fake" },
      { text: `fake note followed by ${providerToken}` },
    ])
      expect(() => parseExecutorSample(jsonl(header, { ...frame, frame: native }))).toThrow(
        "unmarked credential",
      );
    const native = {
      headers: { authorization: "Bearer fake-example" },
      usage: { input_tokens: 24 },
      description: "Give a basic example of a token count.",
      access_token: ["fake-part"],
      text: "https://test.invalid/?api_key=fake-key",
    };
    expect(
      parseExecutorSample(jsonl(header, { ...frame, frame: native })).frames[0]?.frame,
    ).toEqual(native);
  });
});

const environment = { environmentId: "studio", through: "0", objects: [] };
const request = {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "studio",
  connectionId: "active",
  challengeId: "challenge",
  challenge: `fake${"0".repeat(39)}`,
  signer: { kind: "device", deviceId: "desktop", keyId: "fake-key" },
  sequence: 2,
  commandId: "allow",
  method: "input.releaseQueue",
  payload: { threadId: "notes" },
  signature: `fake${"0".repeat(82)}`,
};
const command = { kind: "commands", deviceId: "desktop", requests: [request] };
const accepted = { kind: "accepted", commandId: "allow", result: { kind: "actionAccepted" } };
const group = { after: "release", environmentId: "studio", messages: [accepted] };
function example(event: unknown = command, expected: unknown[] = [group]) {
  return {
    format: "kraka-scenario-v2",
    name: "release",
    description: "Release the pending input.",
    startTime: 0,
    environments: [environment, { ...environment, environmentId: "archive" }],
    clients: ["desktop", "tablet"].map((deviceId) => ({
      deviceId,
      principalId: "owner",
      connections: [
        {
          environmentId: "studio",
          connectionId: deviceId === "desktop" ? "active" : "other",
          subscriptions: [],
        },
      ],
      expected: deviceId === "desktop" ? expected : [],
    })),
    inputs: [
      { label: "release", event },
      { label: "later", event: { kind: "advanceTime", milliseconds: 1 } },
    ],
  };
}

describe("user scenario format", () => {
  test("reads the method-specific command and server receipt", () => {
    expect(parseScenario(example()).clients[0]?.expected[0]?.messages[0]).toMatchObject(accepted);
    expect(() =>
      parseScenario(example({ ...command, requests: [{ ...request, payload: { threadId: 1 } }] })),
    ).toThrow();
    expect(() =>
      parseScenario(
        example(command, [{ ...group, messages: [{ ...accepted, result: { kind: "missing" } }] }]),
      ),
    ).toThrow();
    expect(() => parseScenario(example(command, [{ ...group, messages: [request] }]))).toThrow();
  });
  test("accepts adapter facts only with the replay family and its contract fields", () => {
    const fact = {
      family: "replay",
      instanceId: "replay",
      sessionId: "native-notes",
      epoch: 1,
      eventId: "wrote",
      payload: { kind: "deliveryWritten", attemptId: "attempt", deliveryId: "delivery", at: 0 },
    };
    const event = { kind: "executor", environmentId: "studio", threadId: "notes", fact };
    expect(parseScenario(example(event, [])).inputs[0]?.event?.kind).toBe("executor");
    const { instanceId, ...legacy } = fact;
    expect(instanceId).toBe("replay");
    const historical = example({ ...event, fact: legacy }, []);
    expect(parseScenario({ ...historical, format: "kraka-scenario-v1" }).format).toBe(
      "kraka-scenario-v1",
    );
    expect(() => parseScenario(historical)).toThrow();
    for (const invalid of [
      { ...fact, family: "codex" },
      { ...fact, payload: { kind: "deliveryWritten", at: 0 } },
    ]) {
      expect(() => parseScenario(example({ ...event, fact: invalid }, []))).toThrow();
    }
  });
  test("requires an input and its signer to address a configured client endpoint", () => {
    for (const event of [
      { ...command, deviceId: "unknown" },
      { ...command, deviceId: "tablet" },
      { ...command, requests: [request, { ...request, environmentId: "archive" }] },
      { kind: "restart", environmentId: "missing" },
    ])
      expect(() => parseScenario(example(event))).toThrow();
  });
  test("requires unique input labels and ordered deliveries on known endpoints", () => {
    const duplicate = example();
    duplicate.inputs.push({ label: "release", event: command });
    expect(() => parseScenario(duplicate)).toThrow("Duplicate input label");
    for (const groups of [
      [{ ...group, after: "missing" }],
      [{ ...group, after: "later" }, group],
      [{ ...group, environmentId: "archive" }],
    ]) {
      expect(() => parseScenario(example(command, groups))).toThrow();
    }
  });
  test("checks fake markers even on correctly shaped signatures", () => {
    expect(() =>
      parseScenario(example({ ...command, requests: [{ ...request, signature: "0".repeat(86) }] })),
    ).toThrow("unmarked credential");
  });
});

test("locates malformed envelopes and a missing first frame", () => {
  expect(() => parseExecutorSample(jsonl({ ...header, protocol: null }, frame))).toThrow(
    "header at line 1",
  );
  expect(() => parseExecutorSample(jsonl(header, { ...frame, channel: "file" }))).toThrow(
    "frame at line 2",
  );
  expect(() => parseExecutorSample(jsonl(header))).toThrow("EOF at line 2");
  expect(() => parseExecutorSample("")).toThrow("EOF at line 1");
});
