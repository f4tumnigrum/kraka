import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { realpathSync } from "node:fs";
import {
  query,
  type Query,
  type SDKUserMessage,
  type CanUseTool,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterEventPayload,
  AdapterSessionBinding,
  OpenSessionInput,
  AdapterCommand,
  AdapterEventEnvelope,
  AdapterFailure,
} from "@kraka/environment";
import type { NativeSessionId } from "@kraka/protocol";
import { ClaudeApprovals, ok, rejected } from "./approvals";
import { decodeClaudeCodeFrame, nativeInputIds, type ClaudeInit } from "./native";
import { translateClaudeCodeFrame, type ClaudeTurnState } from "./translate";

export const sdkMode = { ask: "default", edits: "acceptEdits", open: "bypassPermissions" } as const;
export async function within<T>(work: Promise<T>, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Error("Control deadline elapsed")), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function inputUUID(id: string): id is `${string}-${string}-${string}-${string}-${string}` {
  return /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id);
}
type Input = Extract<AdapterCommand, { kind: "deliverInput" }>;
type Stop = Extract<AdapterCommand, { kind: "stop" }>;
type Binding = AdapterSessionBinding<"claude-code"> & { nativeSessionId: NativeSessionId };

export class ClaudeCodeSessionHandle {
  readonly family = "claude-code";
  readonly connection: Query;
  readonly controller = new AbortController();
  readonly approvals: ClaudeApprovals;
  readonly input: AsyncGenerator<SDKUserMessage>;
  readonly records: AdapterEventEnvelope<"claude-code">[] = [];
  readonly sdkVersion: string;
  init: ClaudeInit | null = null;
  state: ClaudeTurnState | null = null;
  interruptIntent: Stop | null = null;
  closed = false;
  failure: AdapterFailure | null = null;
  private readonly inputReady = Promise.withResolvers<SDKUserMessage | null>();
  private readonly picked = Promise.withResolvers<boolean>();
  private readonly inputEnd = Promise.withResolvers<void>();
  private readonly policyReady = Promise.withResolvers<boolean>();
  private readonly childEnded = Promise.withResolvers<void>();
  private readonly consumed = new Map<string, string>();
  private child: ChildProcessWithoutNullStreams | undefined;
  private reader: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private notice = Promise.withResolvers<void>();
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private delivery: Input | null = null;
  private handed = false;
  private early: { raw: unknown; observedAt: number }[] = [];

  constructor(
    readonly binding: Binding,
    readonly attemptId: Input["attemptId"],
    private setup: OpenSessionInput<"claude-code">["setup"],
    executable: string,
    sdkVersion: string,
    readonly cliVersion: string,
  ) {
    this.sdkVersion = sdkVersion;
    this.approvals = new ClaudeApprovals(binding, attemptId, (source, event) =>
      this.publish(source, [event]),
    );
    this.input = this.inputs();
    const mode = setup.permission.selected;
    const canUseTool: CanUseTool = async (name, input, options) => {
      if (
        !(await this.policyReady.promise) ||
        this.closed ||
        this.failure ||
        !this.state?.answered ||
        this.state.ended ||
        options.agentID ||
        !this.init?.tools.includes(name)
      )
        return { behavior: "deny", message: "Request unavailable" };
      return this.approvals.open(name, input, options);
    };
    this.connection = query({
      prompt: this.input,
      options: {
        cwd: setup.workingDirectory,
        additionalDirectories: [...setup.additionalDirectories],
        model: setup.model.id,
        env: { ...setup.environment },
        sessionId: binding.nativeSessionId,
        pathToClaudeCodeExecutable: executable,
        permissionMode: sdkMode[mode],
        allowDangerouslySkipPermissions: mode === "open",
        includePartialMessages: true,
        settingSources: [],
        abortController: this.controller,
        canUseTool,
        ...(mode === "ask"
          ? { settings: { permissions: { ask: ["Bash", "Edit", "Write", "MultiEdit"] } } }
          : {}),
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: "pipe",
            windowsHide: true,
          });
          this.child = child;
          child.stderr.resume();
          child.once("exit", () => this.childEnded.resolve());
          child.once("error", () => this.childEnded.resolve());
          return child;
        },
      },
    });
  }
  private async *inputs(): AsyncGenerator<SDKUserMessage> {
    const value = await this.inputReady.promise;
    if (!value || this.closed || this.failure) {
      this.picked.resolve(false);
      return;
    }
    this.picked.resolve(true);
    yield value;
    await this.inputEnd.promise;
  }
  private publish(source: string, events: readonly AdapterEventPayload[]) {
    for (const [index, payload] of events.entries())
      this.records.push({
        family: this.family,
        instanceId: this.binding.instanceId,
        sessionId: this.binding.nativeSessionId,
        epoch: this.binding.epoch,
        eventId: this.binding.epoch + "/" + source + "/" + index,
        payload,
      });
    this.notice.resolve();
    this.notice = Promise.withResolvers<void>();
  }
  private lose(failure: AdapterFailure) {
    if (this.closed || this.failure || this.state?.ended) return;
    this.failure = failure;
    clearTimeout(this.initTimer);
    this.approvals.close();
    this.policyReady.resolve(false);
    this.inputReady.resolve(null);
    this.picked.resolve(false);
    this.inputEnd.resolve();
    this.publish("lost", [{ kind: "sessionLost", failure }]);
    this.controller.abort();
  }
  private accept(raw: unknown, observedAt: number) {
    try {
      const frame = decodeClaudeCodeFrame(raw, observedAt);
      if (!frame || !this.state || this.failure) return;
      if (frame.sessionId !== this.binding.nativeSessionId) {
        if (frame.payload.kind === "init") throw Error("Foreign init");
        return;
      }
      const signature = JSON.stringify(raw);
      const prior = this.consumed.get(frame.source);
      if (prior !== undefined) {
        if (prior !== signature) throw Error("Conflicting SDK message UUID");
        return;
      }
      this.consumed.set(frame.source, signature);
      if (frame.payload.kind === "init") {
        const init = frame.payload.value;
        if (
          init.claude_code_version !== this.cliVersion ||
          init.permissionMode !== sdkMode[this.setup.permission.selected] ||
          init.model !== this.setup.model.id ||
          realpathSync.native(init.cwd) !== realpathSync.native(this.setup.workingDirectory)
        )
          throw Error("CLI init disagrees with session setup");
        clearTimeout(this.initTimer);
        this.init = init;
        this.policyReady.resolve(true);
        this.publish(frame.source, [
          {
            kind: "permissionApplied",
            attemptId: this.attemptId,
            mode: this.setup.permission.selected,
            enforcement: "native",
            effectiveAt: "now",
            toolId: null,
          },
        ]);
        return;
      }
      if (!this.init) throw Error("SDK output before init");
      const next = translateClaudeCodeFrame(frame, this.state);
      this.state = next.state;
      this.publish(frame.source, next.events);
      if (this.state.ended) this.approvals.close();
    } catch {
      this.lose({ kind: "protocolError", message: "Invalid Claude SDK session evidence" });
    }
  }
  start() {
    this.reader ??= this.read();
  }
  private async read() {
    void within(this.connection.initializationResult(), 10000).catch(() =>
      this.lose({ kind: "transportError", message: "Claude SDK initialization failed" }),
    );
    try {
      for await (const raw of this.connection) {
        const observedAt = Date.now();
        if (this.closed || this.failure) break;
        if (this.handed) this.accept(raw, observedAt);
        else this.early.push({ raw, observedAt });
      }
    } catch {
      // Classify termination from the owned child and the state of its pipe below.
    }
    const code = this.child?.exitCode ?? null,
      signal = this.child?.signalCode ?? null;
    this.lose(
      code !== null || signal !== null
        ? { kind: "unexpectedExit", code, signal }
        : { kind: "transportError", message: "Claude SDK stream closed" },
    );
  }
  async *events(after: string | null) {
    const at = after === null ? -1 : this.records.findIndex((e) => e.eventId === after);
    if (after !== null && at < 0) throw Error("Unknown Claude event cursor");
    this.start();
    let i = at + 1;
    while (true) {
      const e = this.records[i];
      if (e) {
        ++i;
        yield e;
        continue;
      }
      if (this.closed || this.failure || this.state?.ended) return;
      await this.notice.promise;
    }
  }
  async deliver(command: Input) {
    if (this.delivery) {
      if (command.deliveryId !== this.delivery.deliveryId) return rejected("invalidState");
      if (!Bun.deepEquals(command, this.delivery)) return rejected("idConflict");
      return this.handed
        ? ok({ kind: "written" as const, deliveryId: command.deliveryId })
        : rejected("unsafeToRetry");
    }
    if (this.failure || this.closed || command.attemptId !== this.attemptId)
      return rejected("invalidState");
    if (command.input.attachments.length || !inputUUID(command.input.id))
      return rejected("unsupported");
    this.start();
    this.delivery = structuredClone(command);
    this.state = {
      sessionId: this.binding.nativeSessionId,
      attemptId: this.attemptId,
      deliveryId: command.deliveryId,
      input: { ...nativeInputIds(command.input.id), text: command.input.text },
      received: false,
      answered: false,
      ended: false,
      blocks: new Map(),
      tools: new Map(),
    };
    this.initTimer = setTimeout(
      () => this.lose({ kind: "transportError", message: "Claude initialization timed out" }),
      10000,
    );
    this.inputReady.resolve({
      type: "user",
      uuid: command.input.id,
      session_id: this.binding.nativeSessionId,
      parent_tool_use_id: null,
      message: { role: "user", content: command.input.text },
    });
    try {
      if (!(await within(this.picked.promise, 10000))) return rejected("operationRejected");
    } catch {
      this.lose({ kind: "transportError", message: "Claude SDK did not pick up the input" });
      return rejected("unsafeToRetry");
    }
    this.handed = true;
    for (const e of this.early.splice(0)) this.accept(e.raw, e.observedAt);
    return ok({ kind: "written" as const, deliveryId: command.deliveryId });
  }
  async stop(command: Stop) {
    if (
      this.closed ||
      this.failure ||
      !this.state?.answered ||
      this.state.ended ||
      this.attemptId !== command.attemptId
    )
      return rejected("invalidState");
    if (this.interruptIntent) return rejected("unsafeToRetry");
    this.interruptIntent = command;
    try {
      await within(this.connection.interrupt(), 10000);
      return ok({ kind: "written" as const, deliveryId: command.deliveryId });
    } catch {
      return rejected("unsafeToRetry");
    }
  }
  resolveTool(r: Parameters<ClaudeApprovals["resolveTool"]>[0]) {
    return this.approvals.resolveTool(r);
  }
  close() {
    this.closing ??= this.shutdown();
    return this.closing;
  }
  private async shutdown() {
    this.closed = true;
    clearTimeout(this.initTimer);
    this.approvals.close();
    this.policyReady.resolve(false);
    this.inputReady.resolve(null);
    this.picked.resolve(false);
    this.inputEnd.resolve();
    this.notice.resolve();
    this.connection.close();
    if (this.child) {
      try {
        await within(this.childEnded.promise, 2000);
      } catch {
        this.child.kill("SIGKILL");
        await within(this.childEnded.promise, 2000);
      }
    }
    this.controller.abort();
    await this.reader;
  }
}
