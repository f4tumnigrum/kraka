import * as v from "valibot";
import { NativeSessionIdSchema, NativeRootTurnIdSchema, NativeItemIdSchema } from "@kraka/protocol";
import type { RoundEnd } from "@kraka/environment";

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Malformed Codex object");
  return value as Record<string, unknown>;
}
export function string(value: unknown) {
  if (typeof value !== "string") throw new Error("Malformed Codex string");
  return value;
}
export class NativeError extends Error {
  constructor(
    readonly reason:
      | "notAuthenticated"
      | "usageLimited"
      | "operationRejected"
      | "unsafeToRetry"
      | "invalidState"
      | "unsupported",
    message: string,
    readonly code: number | null = null,
  ) {
    super(message);
  }
}
export function failure(raw: unknown, secrets: readonly string[]) {
  const err = object(raw);
  const data = err.data && typeof err.data === "object" ? object(err.data) : err;
  const info = data.codexErrorInfo;
  const code =
    typeof info === "string"
      ? info
      : info && typeof info === "object"
        ? Object.keys(info)[0]
        : null;
  let message = typeof err.message === "string" ? err.message : "Codex rejected the request";
  for (const secret of secrets) if (secret) message = message.replaceAll(secret, "[redacted]");
  message = message
    .replace(
      /(?:Bearer\s+\S+|\b(?:sk-|ghp_)[\w-]+|(?:api[_-]?key|token|password)\s*[=:]\s*[^\s,;]+)/gi,
      "[redacted]",
    )
    .replace(/(?:[A-Za-z]:[\\/]|(?:^|\s)\/)[^\s,;]+/g, " [path]")
    .slice(0, 512);
  return new NativeError(
    code === "unauthorized"
      ? "notAuthenticated"
      : code === "usageLimitExceeded"
        ? "usageLimited"
        : "operationRejected",
    message,
    typeof err.code === "number" ? err.code : null,
  );
}
const turnSchema = v.object({
  id: NativeRootTurnIdSchema,
  rootTurnId: v.optional(v.nullable(NativeRootTurnIdSchema)),
  startedAt: v.optional(v.unknown()),
  completedAt: v.optional(v.unknown()),
  status: v.string(),
  error: v.optional(v.unknown()),
});
export function parseTurn(value: unknown, secrets: readonly string[]) {
  const turn = v.parse(turnSchema, value);
  let outcome: RoundEnd = {
    reason:
      turn.status === "completed"
        ? "completed"
        : turn.status === "interrupted"
          ? "stopped"
          : "unknown",
    nativeReason: turn.status,
  };
  if (turn.status === "failed") {
    const err = failure(turn.error ?? {}, secrets);
    const detail =
      err.reason === "notAuthenticated"
        ? ({ kind: "authentication", message: err.message } as const)
        : err.reason === "usageLimited"
          ? ({ kind: "usageLimit", resetAt: null } as const)
          : ({ kind: "operationRejected", message: err.message } as const);
    outcome = { reason: "failed", failure: detail, nativeReason: err.message };
  }
  return { ...turn, outcome };
}
const address = { threadId: NativeSessionIdSchema, turnId: NativeRootTurnIdSchema };
const targeted = v.object(address);
const item = v.variant("type", [
  v.object({
    type: v.literal("commandExecution"),
    id: NativeItemIdSchema,
    command: v.string(),
    aggregatedOutput: v.nullable(v.string()),
    exitCode: v.nullable(v.pipe(v.number(), v.integer())),
  }),
  v.object({ type: v.literal("agentMessage"), id: NativeItemIdSchema, text: v.string() }),
  v.object({
    type: v.literal("userMessage"),
    id: NativeItemIdSchema,
    clientId: v.optional(v.nullable(v.string())),
  }),
]);
export function notification(method: string, raw: unknown, secrets: readonly string[]) {
  if (method === "turn/started" || method === "turn/completed") {
    const p = object(raw);
    return {
      method,
      threadId: v.parse(NativeSessionIdSchema, p.threadId),
      turn: parseTurn(p.turn, secrets),
    } as const;
  }
  if (method === "item/agentMessage/delta" || method === "item/commandExecution/outputDelta") {
    const p = v.parse(v.object({ ...address, itemId: NativeItemIdSchema, delta: v.string() }), raw);
    return { method, ...p } as const;
  }
  if (method === "item/started" || method === "item/completed") {
    const p = object(raw);
    if (!["userMessage", "agentMessage", "commandExecution"].includes(string(object(p.item).type)))
      return null;
    return { method, ...v.parse(targeted, p), item: v.parse(item, p.item) } as const;
  }
  return null;
}
export type CodexNativeFrame = NonNullable<ReturnType<typeof notification>>;
