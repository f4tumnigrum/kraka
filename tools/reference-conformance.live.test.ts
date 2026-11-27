import { expect, test } from "bun:test";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  fixture,
  launch,
  sampleRequest,
  terminate,
  within,
  withState,
} from "./fixtures/replay-process";
import { readReplayFromReference, validateNamed } from "./reference-client";

const root = resolve(import.meta.dir, "..");
const schemaFile = "docs/generated/protocol/protocol.schema.json";
const kinds = [
  "accepted",
  "round.started",
  "tool.started",
  "tool.output",
  "tool.ended",
  "assistant.delta",
  "assistant.delta",
  "assistant.final",
  "round.ended",
];

async function run(cwd: string, ...args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], {
    cwd,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    const [stdout, stderr, code] = await within(
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      15_000,
      args.join(" "),
    );
    return { stdout, stderr, code };
  } finally {
    await terminate(child);
  }
}

async function checkCurrentReader(url: string) {
  const { stdout, stderr, code } = await run(
    root,
    "tools/reference-client.ts",
    "--url",
    url,
    "--schema",
    schemaFile,
  );
  expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  const lines = stdout.split("\n");
  expect(lines.pop()).toBe("");
  const frames = lines.map((line) => JSON.parse(line));
  expect(frames.map((frame) => frame.kind)).toEqual(kinds);

  const recording = (await readFile(join(root, fixture), "utf8"))
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  function paramsAt(seq: number, method: string) {
    const row = recording[seq];
    expect([row.seq, row.frame.method]).toEqual([seq, method]);
    return row.frame.params;
  }
  const start = paramsAt(9, "turn/started");
  const toolStart = paramsAt(12, "item/started").item;
  const output = paramsAt(13, "item/commandExecution/outputDelta");
  const toolEnd = paramsAt(14, "item/completed").item;
  const delta1 = paramsAt(16, "item/agentMessage/delta");
  const delta2 = paramsAt(17, "item/agentMessage/delta");
  const reply = paramsAt(18, "item/completed").item;
  const end = paramsAt(19, "turn/completed").turn;
  const { threadId, messageId, roundId, attemptId, deliveryId } = frames[0].result;
  const ids = { roundId, attemptId };
  const assistant = { ...ids, role: "assistant" };
  expect(frames).toEqual([
    {
      kind: "accepted",
      commandId: "run-1",
      result: { kind: "threadStarted", threadId, messageId, ...ids, deliveryId },
    },
    {
      kind: "round.started",
      ...ids,
      nativeSessionId: start.threadId,
      nativeRootTurnId: start.turn.rootTurnId,
      startedAt: start.turn.startedAt * 1000,
      phase: "working",
      selectedMode: "ask",
      effectiveMode: "ask",
      supportedModes: ["ask"],
      enforcement: "adapter",
    },
    { kind: "tool.started", ...ids, callId: toolStart.id, command: toolStart.command },
    { kind: "tool.output", ...ids, callId: output.itemId, text: output.delta },
    {
      kind: "tool.ended",
      ...ids,
      callId: toolEnd.id,
      output: toolEnd.aggregatedOutput,
      exitCode: toolEnd.exitCode,
    },
    {
      kind: "assistant.delta",
      ...assistant,
      itemId: delta1.itemId,
      streaming: true,
      text: delta1.delta,
    },
    {
      kind: "assistant.delta",
      ...assistant,
      itemId: delta2.itemId,
      streaming: true,
      text: delta2.delta,
    },
    { kind: "assistant.final", ...assistant, itemId: reply.id, streaming: false, text: reply.text },
    {
      kind: "round.ended",
      ...ids,
      nativeRootTurnId: end.rootTurnId,
      endedAt: end.completedAt * 1000,
      outcome: end.status,
      phase: "closing",
    },
  ]);
}

async function checkLegacyReader(url: string) {
  const document = await Bun.file(join(root, schemaFile)).json();
  document.$defs.ReplayTurnUpdate = {
    allOf: [
      document.$defs.ReplayTurnUpdate,
      {
        type: "object",
        properties: {
          kind: {
            enum: [
              "round.started",
              "tool.started",
              "tool.ended",
              "assistant.delta",
              "assistant.final",
              "round.ended",
            ],
          },
        },
      },
    ],
  };
  const prefix: [number, string][] = [];
  const result = await readReplayFromReference({
    url,
    document,
    request: sampleRequest,
    onFrame: (frame, position) => {
      prefix.push([position, frame.kind]);
    },
  });
  expect(prefix).toEqual([
    [1, "accepted"],
    [2, "round.started"],
    [3, "tool.started"],
  ]);
  expect(result).toEqual({
    kind: "unsupported",
    observedKind: "tool.output",
    position: 4,
    lastUnderstood: 3,
    receivedKinds: kinds,
    closeCode: 1000,
  });
}

async function checkExtraField(url: string) {
  const request = { ...sampleRequest, extra: true };
  const document = await Bun.file(join(root, schemaFile)).json();
  expect(validateNamed(document, "ReplayRunRequest", request)).toBe(false);
  const socket = new WebSocket(url);
  const messages: unknown[] = [];
  try {
    const closed = new Promise<number>((resolve, reject) => {
      socket.onopen = () => socket.send(JSON.stringify(request));
      socket.onmessage = (e) => {
        messages.push(e.data);
      };
      socket.onerror = () => reject(new Error("Extra-field connection failed"));
      socket.onclose = (e) => resolve(e.code);
    });
    expect(await within(closed, 10_000, "Extra-field request")).toBe(1007);
    expect(messages).toEqual([]);
  } finally {
    socket.terminate();
  }
}

async function checkStaleReference(dir: string) {
  const protocol = "node_modules/@kraka/protocol";
  for (const [source, destination] of [
    ["package.json", "package.json"],
    ["tools/protocol-reference.ts", "tools/protocol-reference.ts"],
    ["docs/generated/protocol", "docs/generated/protocol"],
    ["packages/protocol/src", `${protocol}/src`],
    ["packages/protocol/package.json", `${protocol}/package.json`],
    ["node_modules/valibot", "node_modules/valibot"],
    ["node_modules/@valibot/to-json-schema", "node_modules/@valibot/to-json-schema"],
  ] as const) {
    await cp(join(root, source), join(dir, destination), { recursive: true, dereference: true });
  }
  const check = () => run(dir, "run", "protocol:reference:check");
  expect((await check()).code).toBe(0);
  const source = join(dir, protocol, "src/replay.ts");
  const original = await readFile(source, "utf8");
  await writeFile(
    source,
    original.replace('v.literal("replay.run")', 'v.literal("replay.changed")'),
  );
  const stale = await check();
  expect(stale.code).toBe(1);
  expect(stale.stderr).toContain("Stale files: index.md, protocol.schema.json");
  expect((await run(dir, "run", "protocol:reference")).code).toBe(0);
  const document = await Bun.file(join(dir, schemaFile)).json();
  expect(document.$defs.ReplayRunRequest.properties.kind.const).toBe("replay.changed");
  expect((await check()).code).toBe(0);
}

test("live replay agrees with the published reference and preserves the first unknown change", async () => {
  await withState(async (dir) => {
    const daemon = launch(root, dir);
    try {
      const ready = await daemon.ready();
      if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
      await checkCurrentReader(ready.url);
      console.log("Reference assertion group 1 completed: J-1.5");
      await checkLegacyReader(ready.url);
      console.log("Reference assertion group 2 completed: S-STATE-054");
      await checkExtraField(ready.url);
      await withState(checkStaleReference);
      console.log("Reference assertion group 3 completed: extra field and stale reference");
    } finally {
      await daemon.stop();
    }
  });
}, 110_000);
