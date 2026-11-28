import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { ReplayRunRequestSchema } from "@kraka/protocol";

export const fixture = "fixtures/executors/codex/basic-turn.jsonl";
export const entry = "packages/daemon/src/index.ts";
export const sampleRequest = v.parse(ReplayRunRequestSchema, {
  kind: "replay.run",
  commandId: "run-1",
  permission: "ask",
  input: {
    text: "Print the word amber and report what appeared.",
    references: [],
    attachments: [],
  },
});
export async function withState<T>(run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "kraka-replay-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}
export async function within<T>(promise: Promise<T>, ms: number, description: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${description} deadline exceeded`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}
export function captureStderr(stream: ReadableStream<Uint8Array>) {
  let tail = "";
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream)
      tail = (tail + decoder.decode(chunk, { stream: true })).slice(-8192);
    tail = (tail + decoder.decode()).slice(-8192);
    return tail;
  })();
  return { tail: () => tail, drained };
}
export async function terminate(child: Bun.Subprocess, requestStop = () => child.kill("SIGTERM")) {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      requestStop();
      await within(child.exited, 2000, "Graceful exit");
    } catch {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }
  await child.exited;
}
export function launch(root: string, dir: string, recording = join(root, fixture)) {
  const command = [
    process.execPath,
    join(root, entry),
    "replay",
    "--state-dir",
    dir,
    "--port",
    "0",
    "--recording",
    recording,
  ];
  const started = performance.now();
  const child = Bun.spawn(command, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const stderr = new Response(child.stderr).text();
  let stdout = "";
  const line = Promise.withResolvers<string | null>();
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const bytes of child.stdout) {
      stdout += decoder.decode(bytes, { stream: true });
      const end = stdout.indexOf("\n");
      if (end !== -1) line.resolve(stdout.slice(0, end + 1));
    }
    stdout += decoder.decode();
    line.resolve(null);
  })();
  void drained.catch(line.reject);
  const ready = async () => {
    const record = await line.promise;
    if (record === null) {
      const code = await child.exited;
      return {
        kind: "exit" as const,
        code,
        signal: child.signalCode,
        stdout,
        stderr: await stderr,
      };
    }
    const { url } = v.parse(
      v.strictObject({
        kind: v.literal("ready"),
        url: v.pipe(v.string(), v.regex(/^ws:\/\/127\.0\.0\.1:[1-9]\d{0,4}\/replay$/)),
      }),
      JSON.parse(record),
    );
    if (
      new URL(url).port === "0" ||
      (await readFile(join(dir, "replay-endpoint.json"), "utf8")) !== record
    )
      throw new Error("Invalid replay endpoint publication");
    return { kind: "ready" as const, url };
  };
  return {
    child,
    started,
    ready: () => within(ready(), Math.max(0, started + 10000 - performance.now()), "Daemon ready"),
    stop: async () => {
      await terminate(child);
      await Promise.all([drained, stderr]);
    },
  };
}
