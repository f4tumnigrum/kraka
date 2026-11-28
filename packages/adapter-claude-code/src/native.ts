import * as v from "valibot";
import { NativeItemIdSchema, NativeRootTurnIdSchema, NativeSessionIdSchema } from "@kraka/protocol";
import type { AdapterJsonValue } from "@kraka/environment";

const text = v.string();
const object = v.record(text, v.unknown());
const envelope = v.object({
  type: text,
  uuid: text,
  session_id: NativeSessionIdSchema,
  parent_tool_use_id: v.optional(v.nullable(text)),
  user_message_uuid: v.optional(text),
  user_message_uuids: v.optional(v.array(text)),
  resume_reason: v.optional(text),
});
const result = v.object({
  subtype: text,
  is_error: v.boolean(),
  terminal_reason: v.optional(text),
  stop_reason: v.optional(v.nullable(text)),
});
const init = v.object({
  claude_code_version: text,
  permissionMode: text,
  model: text,
  cwd: text,
  tools: v.array(text),
});
export type ClaudeInit = v.InferOutput<typeof init>;
function json(value: unknown): AdapterJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    typeof value === "number"
  )
    return value;
  if (Array.isArray(value)) return value.map(json);
  return Object.fromEntries(Object.entries(v.parse(object, value)).map(([k, x]) => [k, json(x)]));
}
function block(raw: unknown) {
  const b = v.parse(object, raw);
  switch (b.type) {
    case "tool_use":
      return {
        kind: "tool" as const,
        id: v.parse(NativeItemIdSchema, b.id),
        name: v.parse(text, b.name),
        input: json(b.input),
      };
    case "tool_result":
      return {
        kind: "output" as const,
        id: v.parse(NativeItemIdSchema, b.tool_use_id),
        value: json(b.content),
        error: b.is_error === true,
      };
    case "text":
      return { kind: "text" as const, value: v.parse(text, b.text) };
    case "thinking":
      return { kind: "thinking" as const, value: v.parse(text, b.thinking) };
    default:
      return null;
  }
}
function body(raw: Record<string, unknown>) {
  switch (raw.type) {
    case "system":
      return raw.subtype === "init" ? { kind: "init" as const, value: v.parse(init, raw) } : null;
    case "stream_event": {
      const e = v.parse(object, raw.event);
      if (e.type === "content_block_start")
        return {
          kind: "block" as const,
          index: v.parse(v.number(), e.index),
          value: block(e.content_block),
        };
      if (e.type === "content_block_delta") {
        const d = v.parse(object, e.delta);
        if (d.type === "text_delta" || d.type === "thinking_delta")
          return {
            kind: "delta" as const,
            role: d.type === "text_delta" ? ("assistant" as const) : ("reasoning" as const),
            index: v.parse(v.number(), e.index),
            text: v.parse(text, d.type === "text_delta" ? d.text : d.thinking),
          };
      }
      return { kind: "stream" as const };
    }
    case "assistant": {
      const message = v.parse(v.object({ id: text, content: v.array(v.unknown()) }), raw.message);
      return {
        kind: "assistant" as const,
        itemIds: message.content.map((_, i) => v.parse(NativeItemIdSchema, message.id + "/" + i)),
        blocks: message.content.map(block),
      };
    }
    case "user": {
      const message = v.parse(
        v.object({ role: v.literal("user"), content: v.union([text, v.array(v.unknown())]) }),
        raw.message,
      );
      if (typeof message.content === "string")
        return {
          kind: "echo" as const,
          text: message.content,
          synthetic: raw.isSynthetic === true,
        };
      return {
        kind: "outputs" as const,
        blocks: message.content.map(block),
        structured: raw.tool_use_result === undefined ? null : json(raw.tool_use_result),
      };
    }
    case "tool_progress":
      return { kind: "progress" as const, id: v.parse(NativeItemIdSchema, raw.tool_use_id) };
    case "result":
      return { kind: "result" as const, ...v.parse(result, raw) };
    default:
      return null;
  }
}

export function decodeClaudeCodeFrame(value: unknown, observedAt: number) {
  const raw = v.parse(object, value);
  if (
    !["system", "stream_event", "assistant", "user", "tool_progress", "result"].includes(
      String(raw.type),
    )
  )
    return null;
  if (raw.type === "system" && raw.subtype !== "init") return null;
  const base = v.parse(envelope, raw);
  if (base.parent_tool_use_id != null || base.resume_reason !== undefined) return null;
  const payload = body(raw);
  return (
    payload && {
      source: base.uuid,
      sessionId: base.session_id,
      observedAt,
      firstAnswered: ["stream_event", "assistant", "result"].includes(base.type)
        ? (base.user_message_uuids?.[0] ?? base.user_message_uuid ?? null)
        : null,
      itemId: v.parse(NativeItemIdSchema, base.uuid),
      payload,
    }
  );
}
export type ClaudeCodeNativeFrame = NonNullable<ReturnType<typeof decodeClaudeCodeFrame>>;
export function nativeInputIds(uuid: string) {
  return { itemId: v.parse(NativeItemIdSchema, uuid), root: v.parse(NativeRootTurnIdSchema, uuid) };
}
