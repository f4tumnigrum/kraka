import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import type { CloseReason } from "@kraka/environment";
import sample from "../../../fixtures/executors/codex/basic-turn.jsonl" with { type: "text" };
import { listenReplay } from "./index";

test("a second socket message cancels the accepted run while its native start is pending", async () => {
  const recording = parseReplayRecording(sample);
  const real = createReplayAdapter(recording);
  const reached = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const closed: CloseReason[] = [];
  const workingDirectory = await mkdtemp(join(tmpdir(), "kraka-pending-replay-"));
  try {
    const server = await listenReplay({
      workingDirectory,
      port: 0,
      expectedText: recording.expectedText,
      modelId: recording.modelId,
      adapter: {
        ...real,
        async *events(session, after) {
          for await (const event of real.events(session, after)) {
            if (event.eventId === "9") {
              reached.resolve();
              await release.promise;
            }
            yield event;
          }
        },
        async close(session, reason) {
          closed.push(reason);
          release.resolve();
          return real.close(session, reason);
        },
      },
    });
    const socket = new WebSocket(server.url);
    try {
      const received: string[] = [];
      const accepted = Promise.withResolvers<void>();
      const request = JSON.stringify({
        kind: "replay.run",
        commandId: "two",
        permission: "ask",
        input: { text: recording.expectedText, references: [], attachments: [] },
      });
      const code = new Promise<number>((resolve, reject) => {
        socket.onopen = () => socket.send(request);
        socket.onmessage = (e) => {
          received.push(JSON.parse(String(e.data)).kind);
          accepted.resolve();
        };
        socket.onerror = () => reject(new Error("Replay connection failed"));
        socket.onclose = (e) => resolve(e.code);
      });
      const run = async () => {
        await Promise.all([reached.promise, accepted.promise]);
        expect(received).toEqual(["accepted"]);
        socket.send(request);
        expect(await code).toBe(1007);
        expect(received).toEqual(["accepted"]);
        expect(closed).toEqual(["shutdown"]);
      };
      const timeout = AbortSignal.timeout(10_000);
      await Promise.race([
        run(),
        new Promise<never>((_, reject) =>
          timeout.addEventListener("abort", () => reject(timeout.reason), { once: true }),
        ),
      ]);
    } finally {
      release.resolve();
      socket.terminate();
      await server.shutdown();
    }
  } finally {
    await rm(workingDirectory, { force: true, recursive: true });
  }
}, 15_000);
