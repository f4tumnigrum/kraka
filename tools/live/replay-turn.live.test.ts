// Live cases 3; required groups []
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { CommandReceiptSchema } from "@kraka/protocol";
import * as v from "valibot";
import {
  launch,
  fixture,
  sampleRequest,
  terminate,
  within,
  withState,
} from "../fixtures/replay-process";

const root = resolve(import.meta.dir, "../..");
async function live<T>(run: (url: string) => Promise<T>) {
  return withState(async (dir) => {
    const daemon = launch(root, dir);
    try {
      const ready = await daemon.ready();
      if (ready.kind !== "ready") throw new Error(JSON.stringify(ready));
      return await run(ready.url);
    } finally {
      await daemon.stop();
    }
  });
}
async function client(url: string, permission = "ask", text = sampleRequest.input.text) {
  const child = Bun.spawn(
    [
      process.execPath,
      join(root, "tools/replay-client.ts"),
      "--url",
      url,
      "--command-id",
      sampleRequest.commandId,
      "--mode",
      permission,
      "--text",
      text,
    ],
    { cwd: root, stdout: "pipe", stderr: "pipe", stdin: "ignore" },
  );
  try {
    const [stdout, stderr, exit] = await within(
      Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]),
      11000,
      "Child client",
    );
    return { stdout, stderr, exit };
  } finally {
    await terminate(child);
  }
}
const nativeSessionId = "019b76da-a800-7000-8000-000000010001",
  nativeRootTurnId = "019b76da-abe8-7000-8000-000000010001";
function expected(roundId: string, attemptId: string) {
  const ids = { roundId, attemptId },
    tool = { ...ids, callId: "sample-command" },
    assistant = { ...ids, itemId: "sample-answer", role: "assistant" };
  return [
    {
      kind: "round.started",
      ...ids,
      nativeSessionId,
      nativeRootTurnId,
      startedAt: 1767225601000,
      phase: "working",
      selectedMode: "ask",
      effectiveMode: "ask",
      supportedModes: ["ask"],
      enforcement: "adapter",
    },
    { kind: "tool.started", ...tool, command: "printf 'amber\\n'" },
    { kind: "tool.output", ...tool, text: "amber\n" },
    { kind: "tool.ended", ...tool, exitCode: 0, output: "amber\n" },
    { kind: "assistant.delta", ...assistant, streaming: true, text: "The marker was " },
    { kind: "assistant.delta", ...assistant, streaming: true, text: "amber." },
    { kind: "assistant.final", ...assistant, streaming: false, text: "The marker was amber." },
    {
      kind: "round.ended",
      ...ids,
      nativeRootTurnId,
      endedAt: 1767225603000,
      outcome: "completed",
      phase: "closing",
    },
  ];
}
test("Run a recorded turn through a replay daemon", async () => {
  const old = new Set<string>();
  const transcripts: string[] = [];
  for (let group = 1; group <= 2; group++) {
    await live(async (url) => {
      const { stdout, stderr, exit } = await client(url);
      expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
      const lines = stdout.split("\n");
      expect(lines.pop()).toBe("");
      expect(lines).toHaveLength(9);
      const receipt = v.parse(CommandReceiptSchema, JSON.parse(lines[0] ?? ""));
      if (receipt.kind !== "accepted" || receipt.result.kind !== "threadStarted")
        throw new Error("Missing thread receipt");
      const { threadId, messageId, roundId, attemptId, deliveryId } = receipt.result;
      const ids = { threadId, messageId, roundId, attemptId, deliveryId };
      let rebound = stdout;
      for (const [name, id] of Object.entries(ids)) {
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        expect(old.has(id)).toBe(false);
        old.add(id);
        rebound = rebound.replaceAll(id, name);
      }
      expect(lines.map((line) => JSON.parse(line))).toEqual([
        { kind: "accepted", commandId: "run-1", result: { kind: "threadStarted", ...ids } },
        ...expected(roundId, attemptId),
      ]);
      transcripts.push(rebound);
    });
    console.log(`Replay assertion group ${group} completed`);
  }
  expect(transcripts[1]).toBe(transcripts[0]);
}, 50000);

test("business refusals preserve the next connection's recording", async () => {
  await live(async (url) => {
    for (const [mode, reason] of [
      ["open", "unsupported"],
      ["ask", "invalidState"],
    ] as const) {
      const result = await client(url, mode, "wrong");
      expect(JSON.parse(result.stdout)).toEqual({
        kind: "rejected",
        commandId: "run-1",
        failure: { kind: reason },
      });
      expect(result.exit).not.toBe(0);
      expect(result.stderr).toContain(reason);
    }
    expect((await client(url)).exit).toBe(0);
    const http = url.replace("ws:", "http:");
    for (const path of [http, `${http}?x`, `${http}/extra`])
      expect((await fetch(path)).status).toBe(404);
    for (const frames of [
      [Buffer.from("bad")],
      ["{"],
      [JSON.stringify({ ...sampleRequest, permission: "typo" })],
      [JSON.stringify({ ...sampleRequest, extra: true })],
    ]) {
      const socket = new WebSocket(url);
      try {
        const code = await within(
          new Promise<number>((resolve, reject) => {
            socket.onopen = () => {
              for (const frame of frames) socket.send(frame);
            };
            socket.onerror = () => reject(new Error("Handshake failed"));
            socket.onclose = (e) => resolve(e.code);
          }),
          10000,
          "Malformed request",
        );
        expect(code).toBe(1007);
      } finally {
        socket.terminate();
      }
    }
  });
}, 50000);
test("a bad native recording exits before publishing ready", async () => {
  const rows = (await readFile(join(root, fixture), "utf8")).trimEnd().split("\n");
  for (const [input, reason] of [
    [rows.slice(0, -1).join("\n"), "EOF at line 20"],
    [
      rows
        .map((r, i) => (i === 19 ? r.replace('"rootTurnId":"', '"rootTurnId":"foreign-') : r))
        .join("\n"),
      "line 20",
    ],
    [rows.concat((rows[19] ?? "").replace('"seq":19', '"seq":20')).join("\n"), "line 21"],
  ] as const) {
    await withState(async (dir) => {
      const file = join(dir, "invalid.jsonl");
      await writeFile(file, input);
      const daemon = launch(root, dir, file);
      try {
        const result = await daemon.ready();
        if (result.kind !== "exit") throw new Error("Invalid recording published ready");
        expect(result.code).not.toBe(0);
        expect(result.stderr).toContain(reason);
        expect(result.stdout).toBe("");
        expect(await Bun.file(join(dir, "replay-endpoint.json")).exists()).toBe(false);
      } finally {
        await daemon.stop();
      }
    });
  }
}, 35000);
