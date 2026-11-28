import * as v from "valibot";
import {
  NativeItemIdSchema,
  NativeRootTurnIdSchema,
  type AttemptId,
  type NativeSessionId,
  type DeliveryId,
  type NativeRequestId,
} from "@kraka/protocol";
import type {
  AdapterCommand,
  AdapterEventPayload,
  AdapterEventEnvelope,
  AdapterInstance,
  AdapterFailure,
} from "@kraka/environment";
import { AcpDuplex, type RpcId } from "./rpc";
import { AcpExit, AcpProtocolError } from "./transport";
import { authMessage, terminal, validated, sessionUpdate, reversePermission } from "./native";
import { translateAcpFrame, type AcpTurnState } from "./translate";

type Event = AdapterEventEnvelope<"acp">;
type Permission = NonNullable<ReturnType<typeof reversePermission>>;
const denied = (
  reason: "alreadyClosed" | "unsupported" | "invalidState" | "requestExpired" | "unsafeToRetry",
) => ({ kind: "rejected", reason, message: null }) as const;
export class AcpSessionHandle {
  private queue: Event[] = [];
  private wake = Promise.withResolvers<void>();
  private callbacks = new Map<NativeRequestId, Permission>();
  private deliveries = new Set<DeliveryId>();
  private turn: AcpTurnState | null = null;
  private prompt: RpcId | null = null;
  readonly disabled = new Set<AdapterCommand["capability"]>();
  closed = false;
  constructor(
    readonly rpc: AcpDuplex,
    readonly instance: AdapterInstance<"acp">,
    readonly sessionId: NativeSessionId,
    readonly attemptId: AttemptId,
    readonly epoch: number,
    readonly generation: string,
  ) {
    rpc.onLost = (error) => {
      this.callbacks.clear();
      if (!this.closed) {
        let failure: AdapterFailure = {
          kind: "transportError",
          message: "ACP connection interrupted",
        };
        if (error instanceof AcpProtocolError)
          failure = { kind: "protocolError", message: error.message };
        else if (error instanceof AcpExit)
          failure = { kind: "unexpectedExit", code: error.code, signal: error.signal };
        this.publish("eof", [{ kind: "sessionLost", failure }]);
        this.closed = true;
      }
      this.wake.resolve();
    };
    rpc.onCall = (call) => {
      if (
        call.method !== "session/request_permission" ||
        !this.turn ||
        this.turn.ended ||
        this.turn.cancelled
      )
        return false;
      const callback = reversePermission(call.params, call.id);
      if (!callback || callback.sessionId !== sessionId) return false;
      this.callbacks.set(callback.requestId, callback);
      this.publish(call.cursor, [{ ...callback.payload, attemptId }]);
      return true;
    };
    rpc.onNotice = (method, params, cursor) => {
      if (method !== "session/update" || !this.turn || this.turn.ended) return;
      const value = sessionUpdate(params);
      if (!value || value.sessionId !== sessionId) return;
      if (value.kind === "content") {
        const itemId =
          value.itemId ?? v.parse(NativeItemIdSchema, JSON.stringify([this.turn.root, value.role]));
        this.publish(cursor, [
          {
            kind: "contentDelta",
            attemptId,
            itemId,
            role: value.role,
            text: value.text,
            finalText: null,
          },
        ]);
      } else
        this.publish(cursor, [
          {
            kind: "toolActivity",
            attemptId,
            callId: value.callId,
            relationship: { kind: "root", nativeRootTurnId: this.turn.root },
            phase: value.phase,
            input: value.input,
            output: value.output === null ? null : { text: value.output },
          },
        ]);
    };
  }
  pendingRoot = () => (this.turn && !this.turn.ended ? this.turn.root : null);
  get transport() {
    return this.rpc.transport;
  }
  get connection() {
    return this.rpc.connection;
  }
  available = (id: NativeRequestId) => !this.closed && this.callbacks.has(id);
  private publish(cursor: string, payloads: AdapterEventPayload[]) {
    for (const [index, payload] of payloads.entries())
      this.queue.push({
        ...this.instance,
        sessionId: this.sessionId,
        epoch: this.epoch,
        eventId: cursor + "." + index,
        payload,
      });
    this.wake.resolve();
    this.wake = Promise.withResolvers<void>();
  }
  async *events() {
    for (;;) {
      const batch = this.queue;
      this.queue = [];
      yield* batch;
      if (this.queue.length) continue;
      if (this.closed) return;
      await this.wake.promise;
    }
  }
  async invoke(cmd: AdapterCommand) {
    if (this.closed) return denied("alreadyClosed");
    if (this.disabled.has(cmd.capability)) return denied("unsupported");
    if (this.deliveries.has(cmd.deliveryId)) return denied("unsafeToRetry");
    try {
      switch (cmd.kind) {
        case "deliverInput": {
          if (
            cmd.capability !== "submitTextInput" ||
            cmd.input.attachments.length ||
            cmd.input.references.length
          )
            return denied("unsupported");
          if (this.attemptId !== cmd.attemptId || this.turn) return denied("invalidState");
          this.deliveries.add(cmd.deliveryId);
          const call = this.rpc.request(
            "session/prompt",
            { sessionId: this.sessionId, prompt: [{ type: "text", text: cmd.input.text }] },
            {
              prepare: (id) => {
                this.prompt = id;
                const key = JSON.stringify([this.generation, this.sessionId, "out", id]);
                this.turn = {
                  sessionId: this.sessionId,
                  root: v.parse(NativeRootTurnIdSchema, key),
                  itemId: v.parse(NativeItemIdSchema, key),
                  attemptId: cmd.attemptId,
                  deliveryId: cmd.deliveryId,
                  cancelled: false,
                  ended: false,
                };
              },
              onReply: (r) => {
                if (!this.turn) return;
                if ("code" in r && r.code === -32601) this.disabled.add(cmd.capability);
                const result =
                  "code" in r
                    ? {
                        code: r.code,
                        safeMessage:
                          r.code === -32000 ? authMessage : "The executor rejected the ACP prompt.",
                      }
                    : validated(terminal, r.result);
                const translated = translateAcpFrame(
                  { ...result, observedAt: Date.now() },
                  this.turn,
                );
                this.turn = translated.state;
                this.callbacks.clear();
                this.publish(r.cursor, translated.events);
              },
            },
          );
          await call.written;
          break;
        }
        case "deliverAnswer": {
          const callback = this.callbacks.get(cmd.requestId);
          if (!callback) return denied("requestExpired");
          const reply = cmd.reply;
          if (
            reply?.kind !== "approval" ||
            !callback.choices.some(
              (c) =>
                c.choiceKey === reply.choiceKey &&
                c.scope === reply.scope &&
                c.decision === reply.decision,
            )
          )
            return denied("invalidState");
          this.callbacks.delete(cmd.requestId);
          this.deliveries.add(cmd.deliveryId);
          await this.rpc.reply(callback.id, {
            result: { outcome: { outcome: "selected", optionId: reply.choiceKey } },
          });
          break;
        }
        case "stop": {
          if (
            !this.turn ||
            this.turn.ended ||
            this.turn.cancelled ||
            cmd.attemptId !== this.attemptId ||
            this.prompt === null
          )
            return denied("invalidState");
          this.turn = { ...this.turn, cancelled: true };
          this.deliveries.add(cmd.deliveryId);
          await this.rpc.send({ method: "session/cancel", params: { sessionId: this.sessionId } });
          this.rpc.refreshDeadline(this.prompt);
          for (const c of this.callbacks.values())
            await this.rpc.reply(c.id, { result: { outcome: { outcome: "cancelled" } } });
          this.callbacks.clear();
          break;
        }
        default:
          return denied("unsupported");
      }
      return { kind: "ok", value: { kind: "written", deliveryId: cmd.deliveryId } } as const;
    } catch {
      return denied("unsafeToRetry");
    }
  }
  async close() {
    this.closed = true;
    this.callbacks.clear();
    this.wake.resolve();
    return this.rpc.close();
  }
}
