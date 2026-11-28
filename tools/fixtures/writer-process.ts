import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { InstancePublicationSchema, readInstancePublication } from "@kraka/environment";
import * as v from "valibot";
import { captureStderr, entry, fixture, terminate, within } from "./replay-process";
export const productRoot = resolve(import.meta.dir, "../..");
export type Fault =
  | "locked"
  | "beforeCommit"
  | "afterCommit"
  | "externalWrite"
  | "peer"
  | "local-diff"
  | "claimed"
  | "registered"
  | "beforeSetup"
  | "setupExited"
  | "activity-ledger"
  | "resume"
  | "recovery"
  | "settings";
export function launchWriter(
  stateDir: string,
  root: string,
  point?: Fault | "codex" | "codex-cli",
  recording = join(root, fixture),
  ipc?: (message: unknown) => void,
  executable?: string,
) {
  const argv =
    point === "codex-cli"
      ? [join(root, entry), "start", "--state-dir", stateDir, "--local-owner"]
      : point === "codex"
        ? [join(root, "tools/fixtures/codex-writer.ts"), stateDir]
        : point
          ? [join(root, "tools/fixtures/first-send-writer.ts"), stateDir, root, point]
          : [join(root, entry), "start", "--state-dir", stateDir, "--recording", recording];
  const existingState = existsSync(join(stateDir, "environment.sqlite"));
  const started = performance.now();
  const child = Bun.spawn(
    executable ? [executable, ...argv.slice(1)] : [process.execPath, ...argv],
    {
      cwd: root,
      stdin: point === "codex" ? "pipe" : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(ipc && { ipc }),
    },
  );
  const { tail: stderrTail, drained: stderr } = captureStderr(child.stderr);
  const line = Promise.withResolvers<string>();
  const drained = (async () => {
    let out = "";
    for await (const data of child.stdout) {
      out += new TextDecoder().decode(data);
      if (out.includes("\n")) line.resolve(out.split("\n")[0] ?? "");
    }
    if (!out.includes("\n")) {
      const code = await child.exited;
      const details = (await stderr).trim();
      line.reject(
        Error(
          `Writer exited before publishing readiness (${child.signalCode ?? code})${details ? `: ${details}` : ""}`,
        ),
      );
    }
  })();
  void line.promise.catch(() => {});
  const ready = async () => {
    const raw = await within(line.promise, 11000, "Writer publication").catch((error) => {
      console.error(
        `Writer publication failed (${existingState ? "restart" : "fresh"}), daemon stderr tail:\n${stderrTail() || "(empty)"}`,
      );
      throw error;
    });
    const result = v.parse(
      v.strictObject({
        kind: v.picklist(["ready", "existingInstance"]),
        publication: InstancePublicationSchema,
      }),
      JSON.parse(raw),
    );
    const confirmed = await readInstancePublication(stateDir);
    if (
      !Bun.deepEquals(confirmed, result.publication) ||
      (result.kind === "ready" && result.publication.pid !== child.pid)
    )
      throw new Error("Unconfirmed writer");
    return result;
  };
  return {
    child,
    stderr,
    started,
    ready,
    stderrTail,
    async stop() {
      try {
        if (child.stdin && child.exitCode === null && child.signalCode === null) {
          await child.stdin.end();
          const code = await within(child.exited, 10000, "Codex writer shutdown");
          if (code !== 0) throw Error(`Codex writer exited with ${code}: ${await stderr}`);
        }
      } finally {
        await terminate(child, point === "settings" && ipc ? () => child.disconnect() : undefined);
        await Promise.all([drained, stderr]);
      }
    },
    async kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([drained, stderr]);
    },
  };
}
