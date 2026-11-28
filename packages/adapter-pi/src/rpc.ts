import { spawn } from "node:child_process";
import { join } from "node:path";
import type { AdapterFailure } from "@kraka/environment";
import { parsePiLine, PiError, type PiNativeFrame } from "./native";

export type PiProcess = { executable: string; cwd: string; env: Readonly<Record<string, string>> };
type Reply = {
  command: string;
  resolve: (data: unknown, position: number) => void;
  reject: (err: Error) => void;
};
export class PiRpc {
  readonly child;
  readonly exited;
  private readonly reader;
  private readonly pending = new Map<string, Reply>();
  private sequence = 0;
  private position = 0;
  private closing: Promise<void> | null = null;
  failure: AdapterFailure | null = null;
  onFrame: (frame: PiNativeFrame) => void = () => {};
  onLoss: (failure: AdapterFailure, position: number) => void = () => {};
  constructor(
    launch: PiProcess,
    args: string[],
    readonly epoch: number,
  ) {
    this.child = spawn(launch.executable, args, {
      cwd: launch.cwd,
      env: launch.env,
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    this.exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
      this.child.once("error", reject);
      this.child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void this.exited.catch(() => {});
    this.child.stdin.on("error", () => void this.pipeLost());
    this.reader = this.read();
  }
  private lose(failure: AdapterFailure) {
    if (this.failure) return;
    this.failure = failure;
    for (const waiter of this.pending.values())
      waiter.reject(new PiError("unsafeToRetry", "Pi connection lost"));
    this.pending.clear();
    if (!this.closing) this.onLoss(failure, ++this.position);
  }
  private async pipeLost() {
    if (this.failure) return;
    const child = this.child;
    // EOF can precede both the exit callback and reaping. A zombie still answers kill(pid, 0).
    let gone = child.exitCode !== null || child.signalCode !== null;
    if (!gone && child.pid !== undefined) {
      const pid = String(child.pid);
      try {
        const windows = process.platform === "win32";
        const probe = Bun.spawn(
          windows
            ? [
                join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tasklist.exe"),
                "/FI",
                "PID eq " + pid,
                "/FO",
                "CSV",
                "/NH",
              ]
            : ["/bin/ps", "-o", "stat=", "-p", pid],
          { stdout: "pipe", stderr: "ignore", stdin: "ignore" },
        );
        const [output, code] = await Promise.all([new Response(probe.stdout).text(), probe.exited]);
        if (windows) gone = code === 0 && !output.includes(',"' + pid + '",');
        else gone = (code === 1 && !output.trim()) || (code === 0 && output.trim().startsWith("Z"));
      } catch {
        try {
          process.kill(child.pid, 0);
        } catch (error) {
          gone = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
      }
    }
    gone ||= child.exitCode !== null || child.signalCode !== null;
    if (gone) {
      const status = await this.exited.catch(() => null);
      if (status) {
        this.lose({ kind: "unexpectedExit", ...status });
        return;
      }
    }
    this.lose({ kind: "transportError", message: "Pi RPC pipe closed" });
  }
  private async read() {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let pending = "";
    try {
      for await (const bytes of this.child.stdout) {
        pending += decoder.decode(bytes, { stream: true });
        let end = pending.indexOf("\n");
        while (end >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          this.line(line);
          end = pending.indexOf("\n");
        }
      }
      if (pending + decoder.decode()) throw Error("Incomplete Pi RPC frame");
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        ["EPIPE", "ECONNRESET"].includes(String(error.code))
      )
        await this.pipeLost();
      else this.lose({ kind: "protocolError", message: "Invalid Pi RPC frame" });
      return;
    }
    await this.pipeLost();
  }
  private line(line: string) {
    const position = ++this.position;
    const observedAt = Date.now();
    const frame = parsePiLine(line);
    if (!frame || this.failure) return;
    if (frame.type !== "response") {
      this.onFrame({ event: frame, position, observedAt });
      return;
    }
    const reply = this.pending.get(frame.id);
    if (!reply || reply.command !== frame.command) return;
    this.pending.delete(frame.id);
    if (frame.success) reply.resolve(frame.data, position);
    else reply.reject(new PiError("operationRejected", `Pi rejected ${reply.command}`));
  }
  async write(frame: object) {
    if (this.failure || this.closing) throw new PiError("unsafeToRetry", "Pi RPC is closed");
    await new Promise<void>((resolve, reject) =>
      this.child.stdin.write(`${JSON.stringify(frame)}\n`, (err) =>
        err ? reject(new PiError("unsafeToRetry", "Pi write failed")) : resolve(),
      ),
    );
  }
  async request(
    command: string,
    params: object = {},
    timeout = 30_000,
    accepted?: (data: unknown, position: number) => void,
  ) {
    const id = `pi-${this.epoch}-${++this.sequence}`;
    const wait = Promise.withResolvers<unknown>();
    let timedOut = false;
    this.pending.set(id, {
      command,
      resolve: (data, position) => {
        try {
          accepted?.(data, position);
          wait.resolve(data);
        } catch (error) {
          wait.reject(error);
          this.lose({ kind: "protocolError", message: "Invalid Pi command response" });
        }
      },
      reject: wait.reject,
    });
    const timer = setTimeout(() => {
      timedOut = true;
      wait.reject(new PiError("unsafeToRetry", "Pi RPC response timed out"));
    }, timeout);
    try {
      void this.write({ ...params, type: command, id }).catch(wait.reject);
      return await wait.promise;
    } finally {
      clearTimeout(timer);
      if (!timedOut || !accepted) this.pending.delete(id);
    }
  }
  close() {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    const terminate = setTimeout(() => this.child.kill("SIGTERM"), 2_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 4_000);
    try {
      this.child.stdin.end();
      await Promise.allSettled([this.exited, this.reader]);
    } finally {
      clearTimeout(terminate);
      clearTimeout(kill);
    }
  }
}
