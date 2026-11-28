// Only the locally selected diagnostic peer may expose its stderr to the host.
export function traceClaudeChild(executable: string, kind: "version" | "query") {
  if (process.env.KRAKA_TRACE_CLAUDE_PEER !== executable) return null;
  const startedAt = Date.now();
  const record = (event: string, detail: object) =>
    console.error(
      "Claude peer timing " + JSON.stringify({ event, kind, startedAt, at: Date.now(), ...detail }),
    );
  return {
    spawn(pid: number | undefined) {
      record("spawn", { pid });
    },
    stderr(pid: number | undefined, chunk: Uint8Array) {
      record("stderr", { pid, tail: Buffer.from(chunk).toString("utf8").slice(-2048) });
    },
    exit(pid: number | undefined, code: number | null, signal: string | number | null) {
      record("exit", { pid, code, signal });
    },
  };
}
