import * as v from "valibot";
import { NativeRootTurnIdSchema, type AttemptId, type NativeSessionId } from "@kraka/protocol";
import type {
  ActionPermit,
  AdapterCapability,
  AdapterCallResult,
  AdapterCommand,
  AdapterEventEnvelope,
  AdapterInstance,
  AdapterSession,
  InstanceServiceCommand,
  InstanceServiceResult,
  InvocationResult,
  ProviderAdapter,
  SessionInvocationResult,
  SessionSetup,
} from "@kraka/environment";
import { CodexConnection, type Launch } from "./stdio";
import { type CodexNativeFrame, NativeError, notification, object } from "./native";
import { openThread, selectedModel, type CodexProbe } from "./discovery";
import { translateCodexFrame, type CodexTurnState } from "./translate";
export { probeCodex, selectedModel, type CodexProbe } from "./discovery";
export type { Launch } from "./stdio";
type Frame = { frame: CodexNativeFrame; ordinal: number; observedAt: number | null };
type Event = AdapterEventEnvelope<"codex">;
type Instance = AdapterInstance<"codex">;
type Session = AdapterSession<"codex", CodexSessionHandle>;
const denied = (
  reason: "unsupported" | "invalidState" | "invalidCapabilitySnapshot" | "alreadyClosed",
  message: string | null = null,
) => ({ kind: "rejected", reason, message }) as const;
const ok = <T>(value: T) => ({ kind: "ok", value }) as const;
export class CodexSessionHandle {
  readonly events: Event[] = [];
  private discarded = 0;
  private wake = Promise.withResolvers<void>();
  private early: Frame[] = [];
  state: CodexTurnState | null = null;
  busy = false;
  closed = false;
  lost: Error | null = null;
  constructor(
    readonly rpc: CodexConnection,
    readonly instance: Instance,
    readonly nativeSessionId: NativeSessionId,
    readonly epoch: number,
    readonly attemptId: AttemptId,
    readonly secrets: readonly string[],
  ) {
    rpc.onNotice = (method, params, ordinal, observedAt) => {
      if (!this.busy) return;
      const frame = notification(method, params, this.secrets);
      if (!frame || frame.threadId !== nativeSessionId) return;
      const entry = { frame, ordinal, observedAt };
      if (this.state) this.accept(entry);
      else this.early.push(entry);
    };
    rpc.onLost = (error) => {
      this.lost = error;
      this.wake.resolve();
    };
  }
  private accept({ frame, ordinal, observedAt }: Frame) {
    if (!this.state) return;
    const result = translateCodexFrame(frame, this.state, observedAt);
    this.state = result.state;
    for (const [i, payload] of result.events.entries()) {
      this.events.push({
        ...this.instance,
        sessionId: this.nativeSessionId,
        epoch: this.epoch,
        eventId: `${ordinal}.${i + 1}`,
        payload,
      });
      if (this.events.length > 1024) {
        this.events.shift();
        this.discarded++;
      }
    }
    if (result.lookup) void this.lookup(this.state.root).catch(() => {});
    this.wake.resolve();
    this.wake = Promise.withResolvers<void>();
  }
  private async lookup(root: string) {
    const { result, ordinal } = await this.rpc.reply("thread/read", {
      threadId: this.nativeSessionId,
      includeTurns: true,
    });
    const r = object(result);
    const thread = object(r.thread);
    if (thread.id !== this.nativeSessionId || !Array.isArray(thread.turns)) return;
    const turn = thread.turns.map(object).find((t) => t.id === root && t.status !== "inProgress");
    if (!turn) return;
    const frame = notification("turn/completed", { threadId: thread.id, turn }, this.secrets);
    if (frame) this.accept({ frame, ordinal, observedAt: null });
  }
  async deliver(
    command: Extract<AdapterCommand, { kind: "deliverInput" }>,
    model: SessionSetup["model"],
  ) {
    if (this.busy || command.attemptId !== this.attemptId) return denied("invalidState");
    if (command.input.attachments.length || command.input.references.length)
      return denied("unsupported");
    this.busy = true;
    try {
      const r = object(
        await this.rpc.request("turn/start", {
          threadId: this.nativeSessionId,
          clientUserMessageId: command.deliveryId,
          input: [{ type: "text", text: command.input.text, text_elements: [] }],
          ...model.options,
        }),
      );
      const turn = object(r.turn),
        root = v.parse(NativeRootTurnIdSchema, turn.id);
      if (turn.rootTurnId != null && turn.rootTurnId !== root)
        throw new Error("Foreign root in start response");
      this.state = {
        sessionId: this.nativeSessionId,
        root,
        attemptId: this.attemptId,
        deliveryId: command.deliveryId,
        startedAt: null,
        received: false,
        ended: false,
        finals: new Set(),
        tools: new Set(),
        terminal: null,
      };
      for (const frame of this.early) this.accept(frame);
      return ok({ kind: "written", deliveryId: command.deliveryId } as const);
    } catch (error) {
      if (error instanceof NativeError)
        return { kind: "rejected" as const, reason: error.reason, message: error.message };
      return {
        kind: "rejected" as const,
        reason: "unsafeToRetry" as const,
        message: "Codex input could not be confirmed",
      };
    } finally {
      this.early = [];
    }
  }
  async *stream(after: string | null) {
    let offset = 0;
    if (after !== null) {
      const at = this.events.findIndex((e) => e.eventId === after);
      if (at < 0) throw new Error("Codex event cursor gap");
      offset = this.discarded + at + 1;
    }
    while (true) {
      if (offset < this.discarded) throw new Error("Codex event cursor gap");
      const entry = this.events[offset - this.discarded];
      if (entry) {
        offset++;
        yield entry;
        continue;
      }
      if (this.closed || this.state?.ended) return;
      if (this.lost) throw this.lost;
      await this.wake.promise;
    }
  }
  async close() {
    this.closed = true;
    this.wake.resolve();
    await this.rpc.close();
  }
}
export function createCodexAdapter(
  instance: Instance,
  launch: Launch,
  probe: CodexProbe,
): ProviderAdapter<"codex", CodexSessionHandle> {
  let epoch = 0;
  const handles = new WeakMap<CodexSessionHandle, SessionSetup["model"]>();
  const matches = (i: Instance) =>
    i.family === instance.family && i.instanceId === instance.instanceId;
  const owns = (s: Session) =>
    matches(s) &&
    handles.has(s.handle) &&
    s.nativeSessionId === s.handle.nativeSessionId &&
    s.epoch === s.handle.epoch;
  async function invoke<C extends InstanceServiceCommand>(
    i: Instance,
    p: ActionPermit<"codex", NoInfer<C["capability"]>>,
    c: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  async function invoke<C extends AdapterCommand>(
    s: Session,
    p: ActionPermit<"codex", NoInfer<C["capability"]>>,
    c: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    target: Session | Instance,
    permit: ActionPermit<"codex", AdapterCapability>,
    cmd: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>> {
    if (
      !matches(target) ||
      !matches(permit) ||
      permit.capabilityVersion !== probe.declaration.version ||
      permit.capability !== cmd.capability
    )
      return denied("invalidCapabilitySnapshot");
    if (
      cmd.capability === "generateText" ||
      probe.declaration.matrix[cmd.capability].kind !== "native"
    )
      return denied("unsupported");
    if (!("handle" in target)) {
      if (cmd.capability === "listModels" && probe.models)
        return ok({ kind: "service", result: probe.models });
      if (cmd.capability === "checkAuthentication")
        return ok({
          kind: "service",
          result: { status: probe.declaration.readiness.authenticated, account: null },
        });
      return denied("unsupported");
    }
    if (!owns(target) || target.handle.closed) return denied("invalidState");
    const model = handles.get(target.handle);
    if (cmd.kind !== "deliverInput" || cmd.capability !== "submitTextInput" || !model)
      return denied("unsupported");
    return target.handle.deliver(cmd, model);
  }
  return {
    async capabilities(i) {
      return matches(i) ? ok(probe.declaration) : denied("invalidState");
    },
    invoke,
    async open({ instance: i, attemptId, resume, setup }) {
      if (
        !matches(i) ||
        resume !== null ||
        setup.permission.selected !== "ask" ||
        setup.workingDirectory !== launch.cwd ||
        setup.additionalDirectories.length ||
        Object.values(probe.declaration.readiness).some((l) => l.state !== "yes") ||
        Date.now() >= probe.retryAt
      )
        return denied("unsupported");
      const model = selectedModel(probe.models, setup.model);
      if (!model) return denied("unsupported");
      let rpc: CodexConnection | undefined;
      try {
        rpc = new CodexConnection(launch);
        await rpc.initialize();
        const nativeSessionId = await openThread(rpc, launch.cwd, model);
        const handle = new CodexSessionHandle(
          rpc,
          i,
          nativeSessionId,
          ++epoch,
          attemptId,
          Object.values(launch.env),
        );
        handles.set(handle, model);
        return ok({ ...i, epoch, nativeSessionId, handle });
      } catch (error) {
        await rpc?.close();
        return error instanceof NativeError
          ? { kind: "rejected", reason: error.reason, message: error.message }
          : denied("invalidState", "Codex session could not be opened");
      }
    },
    events(s, after) {
      if (!owns(s)) throw new Error("Foreign Codex session");
      return s.handle.stream(after);
    },
    async close(s) {
      if (!owns(s)) return denied("invalidState");
      if (s.handle.closed) return denied("alreadyClosed");
      await s.handle.close();
      return ok(undefined);
    },
  };
}
export type CodexAdapterFactory = typeof createCodexAdapter;
