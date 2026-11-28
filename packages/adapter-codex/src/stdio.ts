import { failure, NativeError, object } from "./native";
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => void,
) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.decode(chunk, { stream: true });
    let end = pending.indexOf("\n");
    while (end >= 0) {
      onLine(pending.slice(0, end));
      pending = pending.slice(end + 1);
      end = pending.indexOf("\n");
    }
  }
  if (pending + decoder.decode() !== "") throw new Error("Incomplete Codex stdio line");
}
export type Launch = { executable: string; cwd: string; env: Record<string, string> };
export type Notice = (
  method: string,
  params: unknown,
  ordinal: number,
  observedAt: number | null,
) => void;
export class CodexConnection {
  readonly child;
  private readonly reader: Promise<void>;
  private readonly pending = new Map<
    number,
    {
      resolve: (value: { result: unknown; ordinal: number }) => void;
      reject: (error: Error) => void;
    }
  >();
  private nextId = 1;
  private ordinal = 0;
  private lost: Error | null = null;
  onRequest: (method: string, params: unknown, id: string | number, ordinal: number) => boolean =
    () => false;
  onNotice: Notice = () => {};
  onLost: (error: Error) => void = () => {};
  constructor(
    launch: Launch,
    readonly clock: () => number | null = Date.now,
    private readonly authorize = () => true,
  ) {
    this.child = Bun.spawn([launch.executable, "app-server"], {
      cwd: launch.cwd,
      env: launch.env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "ignore",
    });
    this.reader = readLines(this.child.stdout, (line) => {
      const frame = object(JSON.parse(line));
      this.ordinal++;
      if (typeof frame.method === "string") {
        if (typeof frame.id === "string" || typeof frame.id === "number") {
          if (this.onRequest(frame.method, frame.params, frame.id, this.ordinal)) return;
          void Promise.resolve(
            this.write({ id: frame.id, error: { code: -32601, message: "Method not supported" } }),
          ).catch(() => this.fail(new Error("Codex reply write failed")));
        } else this.onNotice(frame.method, frame.params, this.ordinal, this.clock());
      } else if (typeof frame.id === "number") {
        const pending = this.pending.get(frame.id);
        if (!pending) return;
        this.pending.delete(frame.id);
        if ("error" in frame) pending.reject(failure(frame.error, Object.values(launch.env)));
        else if ("result" in frame)
          pending.resolve({ result: frame.result, ordinal: this.ordinal });
        else pending.reject(new Error("Missing RPC result"));
      }
    }).then(
      () => this.fail(new Error("Codex stdout closed")),
      () => this.fail(new Error("Invalid Codex stdio")),
    );
  }
  private fail(error: Error) {
    this.lost = error;
    for (const p of this.pending.values()) p.reject(error);
    this.pending.clear();
    this.onLost(error);
  }
  private write(body: object) {
    if (!this.authorize()) throw Error("Instance authority changed");
    this.child.stdin.write(`${JSON.stringify(body)}\n`);
    return this.child.stdin.flush();
  }
  async respond(id: string | number, result: object) {
    if (this.lost) throw this.lost;
    await this.write({ id, result });
  }
  async request(method: string, params: object, timeout = 30000) {
    return (await this.reply(method, params, timeout)).result;
  }
  async reply(method: string, params: object, timeout = 30000) {
    if (this.lost) throw this.lost;
    if (!Number.isSafeInteger(this.nextId)) throw new Error("RPC ID space exhausted");
    const id = this.nextId++,
      p = Promise.withResolvers<{ result: unknown; ordinal: number }>();
    const timer = setTimeout(
      () => p.reject(new NativeError("unsafeToRetry", "Codex RPC deadline elapsed")),
      timeout,
    );
    this.pending.set(id, p);
    try {
      Promise.resolve(this.write({ id, method, params })).catch(() =>
        p.reject(new NativeError("unsafeToRetry", "Codex write failed")),
      );
      return await p.promise;
    } finally {
      clearTimeout(timer);
      this.pending.delete(id);
    }
  }
  async initialize() {
    const r = object(
      await this.request(
        "initialize",
        { clientInfo: { name: "kraka", title: "kraka", version: "0.1.0" }, capabilities: null },
        10000,
      ),
    );
    if (typeof r.userAgent !== "string" || !r.userAgent)
      throw new Error("Invalid Codex initialize result");
    await this.write({ method: "initialized" });
    return typeof r.codexHome === "string" && r.codexHome.length ? r.codexHome : null;
  }
  async close() {
    const timer = setTimeout(() => {
      if (this.child.exitCode === null) this.child.kill("SIGKILL");
    }, 2000);
    try {
      const results = await Promise.allSettled([
        this.child.stdin.end(),
        this.child.exited,
        this.reader,
      ]);
      if (results[1].status === "rejected") throw results[1].reason;
      if (results[2].status === "rejected") throw results[2].reason;
    } finally {
      clearTimeout(timer);
    }
  }
}
