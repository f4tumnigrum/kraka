import type { PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type {
  AdapterSessionBinding,
  AdapterCallResult,
  AdapterEventPayload,
} from "@kraka/environment";
import {
  NativeItemIdSchema,
  NativeRequestIdSchema,
  type NativeItemId,
  type NativeRequestId,
  type AttemptId,
  type DeliveryId,
  type TodoReplyContent,
} from "@kraka/protocol";
import * as v from "valibot";
export const rejected = (
  reason: Extract<AdapterCallResult<never>, { kind: "rejected" }>["reason"],
  message: string | null = null,
) => ({ kind: "rejected", reason, message }) as const;
export const ok = <T>(value: T) => ({ kind: "ok", value }) as const;
type Binding = AdapterSessionBinding<"claude-code">;
type Resolution = {
  binding: Binding;
  requestId: NativeRequestId;
  toolUseId: NativeItemId;
  deliveryId: DeliveryId;
  answer: TodoReplyContent;
};
export function sameBinding(a: Binding, b: Binding) {
  return (
    a.family === b.family &&
    a.instanceId === b.instanceId &&
    a.nativeSessionId === b.nativeSessionId &&
    a.epoch === b.epoch
  );
}
const choices = (["allow", "deny"] as const).map((decision) => ({
  kind: "approval" as const,
  decision,
  choiceKey: decision,
  scope: "once" as const,
}));
type Pending = {
  binding: Binding;
  toolUseId: NativeItemId;
  input: Record<string, unknown>;
  finish(result: PermissionResult): void;
};
export class ClaudeApprovals {
  readonly pending = new Map<NativeRequestId, Pending>();
  private readonly seen = new Set<NativeRequestId>();
  private readonly delivered = new Map<DeliveryId, Resolution>();
  constructor(
    private binding: Binding,
    private attemptId: AttemptId,
    private publish: (source: string, p: AdapterEventPayload) => void,
  ) {}
  open(
    name: string,
    input: Record<string, unknown>,
    opts: { requestId: string; toolUseID: string; signal: AbortSignal },
  ): Promise<PermissionResult> {
    const requestId = v.parse(NativeRequestIdSchema, opts.requestId),
      toolUseId = v.parse(NativeItemIdSchema, opts.toolUseID);
    const command = name === "Bash";
    const target = command ? input.command : input.file_path;
    if (
      typeof target !== "string" ||
      this.seen.has(requestId) ||
      opts.signal.aborted ||
      !(command || ["Edit", "Write", "MultiEdit"].includes(name))
    )
      return Promise.resolve({ behavior: "deny", message: "Request unavailable" });
    this.seen.add(requestId);
    const deferred = Promise.withResolvers<PermissionResult>();
    const abort = () => {
      const pending = this.pending.get(requestId);
      if (!pending) return;
      this.pending.delete(requestId);
      pending.finish({ behavior: "deny", message: "Request expired" });
      this.publish("callback/closed/" + requestId, {
        kind: "requestClosed",
        requestId,
        attemptId: this.attemptId,
      });
    };
    this.pending.set(requestId, {
      binding: { ...this.binding },
      toolUseId,
      input: structuredClone(input),
      finish: (result) => {
        opts.signal.removeEventListener("abort", abort);
        deferred.resolve(result);
      },
    });
    opts.signal.addEventListener("abort", abort, { once: true });
    this.publish("callback/open/" + requestId, {
      kind: "requestOpened",
      attemptId: this.attemptId,
      requestId,
      nativeNode: toolUseId,
      recovery: "liveOnly",
      body: {
        kind: "approval",
        tool: command ? "command" : "file",
        requestedTool: { id: toolUseId, target },
        choices: choices.map((c) => ({ key: c.choiceKey, scope: c.scope, allowsEdit: false })),
      },
      approval: { permission: command ? "term.input" : "workspace.change", choices },
    });
    return deferred.promise;
  }
  toolForAnswer(requestId: NativeRequestId, deliveryId: DeliveryId) {
    return this.pending.get(requestId)?.toolUseId ?? this.delivered.get(deliveryId)?.toolUseId;
  }
  resolveTool(r: Resolution) {
    if (!sameBinding(this.binding, r.binding)) return rejected("requestExpired");
    const previous = this.delivered.get(r.deliveryId);
    if (previous)
      return Bun.deepEquals(previous, r)
        ? ok({ kind: "written" as const, deliveryId: r.deliveryId })
        : rejected("idConflict");
    const p = this.pending.get(r.requestId);
    if (!p || p.toolUseId !== r.toolUseId || !sameBinding(p.binding, r.binding))
      return rejected("requestExpired");
    const choice = choices.find((c) => Bun.deepEquals(c, r.answer));
    if (!choice) return rejected("unsupported");
    this.pending.delete(r.requestId);
    this.delivered.set(r.deliveryId, structuredClone(r));
    p.finish(
      choice.decision === "allow"
        ? { behavior: "allow", updatedInput: p.input }
        : { behavior: "deny", message: "Denied by the user" },
    );
    return ok({ kind: "written" as const, deliveryId: r.deliveryId });
  }
  close() {
    for (const [requestId, p] of this.pending) {
      this.pending.delete(requestId);
      p.finish({ behavior: "deny", message: "Session closed" });
      this.publish("callback/closed/" + requestId, {
        kind: "requestClosed",
        requestId,
        attemptId: this.attemptId,
      });
    }
  }
}
