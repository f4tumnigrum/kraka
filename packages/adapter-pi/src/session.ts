import * as v from "valibot";
import type {
  AdapterCommand,
  AdapterEventEnvelope,
  AdapterEventPayload,
  AdapterInstance,
  InvocationResult,
} from "@kraka/environment";
import {
  NativeItemIdSchema,
  NativeRootTurnIdSchema,
  type AttemptId,
  type NativeRequestId,
  type NativeItemId,
} from "@kraka/protocol";
import type { openPiProcess } from "./launch";
import {
  dispositionSchema,
  historySchema,
  PiError,
  type PiNativeFrame,
  type UiRequest,
} from "./native";
import { translatePiFrame, type PiState } from "./translate";
type Process = Awaited<ReturnType<typeof openPiProcess>>;
type Envelope = AdapterEventEnvelope<"pi">;
type Answer = Extract<AdapterCommand, { kind: "deliverAnswer" }>;
type Callback = {
  native: UiRequest;
  deadline: number | null;
  opened: Extract<AdapterEventPayload, { kind: "requestOpened" }>;
};
function answerBody({ native, opened }: Callback, cmd: Answer) {
  const reply = cmd.reply;
  if (
    opened.approval &&
    reply?.kind === "approval" &&
    opened.approval.choices.some((c) => Bun.deepEquals(c, reply))
  )
    return { confirmed: reply.decision === "allow" };
  if (opened.body.kind !== "question" || reply?.kind !== "question" || reply.answers.length !== 1)
    return null;
  const [value] = reply.answers;
  if (value.questionKey !== native.id) return null;
  const choices = opened.body.questions[0].choices;
  if (choices.length && !choices.includes(value.answer)) return null;
  return native.method === "confirm"
    ? { confirmed: value.answer === "yes" }
    : { value: value.answer };
}
export class PiSessionHandle {
  private state: PiState;
  private pending: PiNativeFrame[] | null = null;
  private readonly callbacks = new Map<NativeRequestId, Callback>();
  private readonly seenRequests = new Set<NativeRequestId>();
  private readonly toolSources = new Map<NativeItemId, string[]>();
  private wake = Promise.withResolvers<void>();
  private readonly log: Envelope[] = [];
  private offset = 0;
  private closed = false;
  private readonly sent = new Set<AttemptId>();
  readonly nativeSessionId;
  readonly epoch;
  constructor(
    readonly process: Process,
    readonly instance: AdapterInstance<"pi">,
    readonly attemptId: AttemptId,
  ) {
    this.nativeSessionId = process.nativeSessionId;
    this.epoch = process.rpc.epoch;
    this.state = {
      binding: { ...instance, epoch: this.epoch, nativeSessionId: this.nativeSessionId },
      prompt: null,
      root: null,
      lastAssistantReason: null,
      approvalTitle: process.approvalTitle,
      messagePosition: null,
      displayId: (pos, i) => v.parse(NativeItemIdSchema, `pi:${this.epoch}:${pos}:${i}`),
    };
    process.rpc.onFrame = (frame) => {
      if (this.pending) {
        this.pending.push(frame);
        return;
      }
      this.accept(frame);
    };
    process.rpc.onLoss = (failure, position) => {
      this.callbacks.clear();
      this.flushPending();
      this.emit(position, 1, { kind: "sessionLost", failure, observedAt: Date.now() });
    };
  }
  private flushPending() {
    const frames = this.pending ?? [];
    this.pending = null;
    for (const frame of frames) this.accept(frame);
  }
  hasCallback(id: NativeRequestId) {
    const callback = this.callbacks.get(id);
    return !!callback && (callback.deadline === null || Date.now() < callback.deadline);
  }
  private emit(position: number, index: number, payload: AdapterEventPayload) {
    const eventId = `pi:${this.epoch}:${position}:${index}`;
    this.log.push({
      ...this.instance,
      sessionId: this.nativeSessionId,
      epoch: this.epoch,
      eventId,
      payload,
    });
    if (this.log.length > 1024) {
      this.log.shift();
      this.offset++;
    }
    this.wake.resolve();
    this.wake = Promise.withResolvers<void>();
    return eventId;
  }
  private accept(frame: PiNativeFrame) {
    const { events, state } = translatePiFrame(frame, this.state);
    this.state = state;
    const native = frame.event;
    for (const [i, payload] of events.entries()) {
      if (payload.kind === "requestOpened" && native.type === "extension_ui_request") {
        if (this.seenRequests.has(native.id)) continue;
        this.seenRequests.add(native.id);
        this.callbacks.set(native.id, {
          native,
          opened: payload,
          deadline: native.timeout === undefined ? null : frame.observedAt + native.timeout,
        });
      }
      if (payload.kind === "roundEnded") this.callbacks.clear();
      const id = this.emit(frame.position, i + 1, payload);
      if (payload.kind === "sessionObservation" && "toolCallId" in native) {
        const sources = this.toolSources.get(native.toolCallId) ?? [];
        sources.push(id);
        this.toolSources.set(native.toolCallId, sources);
      }
    }
    if (
      state.root &&
      native.type === "message_end" &&
      native.message.role === "assistant" &&
      Array.isArray(native.message.content)
    ) {
      const calls = native.message.content.flatMap((b) =>
        b.type === "toolCall" && b.id ? [b.id] : [],
      );
      if (calls.some((id) => this.toolSources.has(id))) this.linkTools(calls, state.root.attemptId);
    }
  }
  private linkTools(calls: NativeItemId[], attemptId: AttemptId) {
    void this.process.rpc
      .request("get_entries", {}, 30_000, (raw, pos) => {
        const { entries, leafId } = v.parse(historySchema, raw);
        const byId = new Map(entries.map((e) => [e.id, e]));
        if (byId.size !== entries.length) return;
        const branch = new Set<(typeof entries)[number]>();
        for (let id = leafId; id !== null; ) {
          const entry = byId.get(id);
          if (!entry || branch.has(entry)) return;
          branch.add(entry);
          id = entry.parentId;
        }
        let index = 0;
        for (const id of calls) {
          const matches = entries.filter(
            (e) =>
              e.type === "message" &&
              e.message?.role === "assistant" &&
              Array.isArray(e.message.content) &&
              e.message.content.some((b) => b.type === "toolCall" && b.id === id),
          );
          const [item] = matches;
          if (matches.length !== 1 || !item || !branch.has(item)) continue;
          for (const eventId of this.toolSources.get(id) ?? []) {
            this.emit(pos, ++index, {
              kind: "sessionObservationLinked",
              attemptId,
              observation: { eventId, sourceId: id },
              relationship: { kind: "item", nativeItemId: item.id },
            });
          }
          this.toolSources.delete(id);
        }
      })
      .catch(() => {});
  }
  async deliver(cmd: Extract<AdapterCommand, { kind: "deliverInput" }>): Promise<InvocationResult> {
    if (
      (!this.sent.size && cmd.attemptId !== this.attemptId) ||
      this.sent.has(cmd.attemptId) ||
      this.pending ||
      this.state.prompt ||
      this.closed ||
      this.process.rpc.failure
    )
      throw new PiError("invalidState", "Pi attempt unavailable");
    if (cmd.input.attachments.length)
      throw new PiError("unsupported", "Unsupported Pi attachment carrier");
    this.sent.add(cmd.attemptId);
    this.pending = [];
    const rootId = v.parse(NativeRootTurnIdSchema, `weak:pi:${this.epoch}:${cmd.attemptId}`);
    let result: InvocationResult = { kind: "written", deliveryId: cmd.deliveryId };
    try {
      await this.process.rpc.request("prompt", { message: cmd.input.text }, 30_000, (raw) => {
        const { disposition } = v.parse(dispositionSchema, raw);
        if (disposition === "handled") result = { kind: "service", result: { disposition } };
        else
          this.state = {
            ...this.state,
            prompt: {
              attemptId: cmd.attemptId,
              rootId,
              disposition,
              text: cmd.input.text,
              queue: "unseen",
              beganAt: null,
            },
          };
        this.flushPending();
      });
      return result;
    } catch (error) {
      if (error instanceof PiError && error.reason === "operationRejected") this.flushPending();
      throw error;
    }
  }
  async answer(cmd: Answer): Promise<InvocationResult> {
    const callback = this.callbacks.get(cmd.requestId);
    if (!callback || !this.hasCallback(cmd.requestId) || this.closed || this.process.rpc.failure)
      throw new PiError("requestExpired", "Pi callback expired");
    if (cmd.answer.attemptId !== cmd.attemptId || cmd.answer.deliveryId !== cmd.deliveryId)
      throw new PiError("invalidState", "Mismatched answer delivery");
    const body = answerBody(callback, cmd);
    if (!body) throw new PiError("unsupported", "Invalid Pi answer");
    this.callbacks.delete(cmd.requestId);
    await this.process.rpc.write({
      type: "extension_ui_response",
      id: callback.native.id,
      ...body,
    });
    return { kind: "written", deliveryId: cmd.deliveryId };
  }
  async stop(cmd: Extract<AdapterCommand, { kind: "stop" }>): Promise<InvocationResult> {
    if (this.state.root?.attemptId !== cmd.attemptId)
      throw new PiError("invalidState", "No matching Pi root");
    await this.process.rpc.request("abort");
    return { kind: "written", deliveryId: cmd.deliveryId };
  }
  async *events(after: string | null) {
    const cursor = after === null ? -1 : this.log.findIndex((e) => e.eventId === after);
    if ((after !== null && cursor < 0) || (after === null && this.offset > 0))
      throw Error("Pi event cursor expired");
    let next = this.offset + cursor + 1;
    while (true) {
      if (next < this.offset) throw Error("Pi event cursor expired");
      const event = this.log[next - this.offset];
      if (event) {
        next++;
        yield event;
        continue;
      }
      if (this.closed || this.process.rpc.failure) return;
      await this.wake.promise;
    }
  }
  async close() {
    this.closed = true;
    this.callbacks.clear();
    this.wake.resolve();
    await this.process.close();
  }
}
