import * as v from "valibot";
import { NativeItemIdSchema, NativeRequestIdSchema } from "@kraka/protocol";

const text = v.pipe(v.string(), v.nonEmpty());
const header = v.object({ type: text });
const response = v.object({
  type: v.literal("response"),
  id: text,
  command: text,
  success: v.boolean(),
  data: v.optional(v.unknown()),
});
const start = v.object({ type: v.literal("agent_start") });
const settled = v.object({ type: v.literal("agent_settled"), aborted: v.boolean() });
const message = v.object({
  type: v.picklist(["message_start", "message_end"]),
  message: v.object({
    role: text,
    stopReason: v.optional(text),
    content: v.optional(
      v.union([
        v.string(),
        v.array(
          v.object({
            type: text,
            text: v.optional(v.string()),
            thinking: v.optional(v.string()),
            id: v.optional(NativeItemIdSchema),
          }),
        ),
      ]),
    ),
  }),
});
const update = v.object({
  type: v.literal("message_update"),
  assistantMessageEvent: v.object({
    type: text,
    contentIndex: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
    delta: v.optional(v.string()),
    content: v.optional(v.string()),
  }),
});
const tool = v.object({
  type: v.picklist(["tool_execution_start", "tool_execution_update", "tool_execution_end"]),
  toolCallId: NativeItemIdSchema,
});
const ui = v.object({
  type: v.literal("extension_ui_request"),
  id: NativeRequestIdSchema,
  method: v.picklist(["select", "confirm", "input", "editor"]),
  title: text,
  timeout: v.optional(v.pipe(v.number(), v.safeInteger(), v.minValue(0))),
  options: v.optional(v.array(v.string())),
  message: v.optional(v.string()),
});
const queue = v.object({
  type: v.literal("queue_update"),
  steering: v.array(v.string()),
  followUp: v.array(v.string()),
});
const retry = v.object({ type: v.literal("auto_retry_start") });
export const dispositionSchema = v.object({
  disposition: v.picklist(["started", "queued", "handled"]),
});
export const stateSchema = v.object({
  sessionId: v.pipe(v.string(), v.uuid()),
  sessionFile: v.optional(text),
  isStreaming: v.boolean(),
  pendingMessageCount: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  model: v.optional(v.object({ id: text, provider: text })),
});
export const modelsSchema = v.object({
  models: v.array(v.object({ id: text, name: text, provider: text })),
});
export const historySchema = v.object({
  leafId: v.nullable(NativeItemIdSchema),
  entries: v.array(
    v.object({
      type: text,
      id: NativeItemIdSchema,
      parentId: v.nullable(NativeItemIdSchema),
      message: v.optional(message.entries.message),
    }),
  ),
});
export type PiPromptDisposition = v.InferOutput<typeof dispositionSchema>["disposition"];
export type UiRequest = v.InferOutput<typeof ui>;
export type PiEvent = v.InferOutput<
  | typeof start
  | typeof settled
  | typeof message
  | typeof update
  | typeof tool
  | typeof ui
  | typeof queue
  | typeof retry
>;
export type PiNativeFrame = { event: PiEvent; position: number; observedAt: number };
export function parsePiLine(line: string) {
  const raw: unknown = JSON.parse(line);
  const { type } = v.parse(header, raw);
  switch (type) {
    case "response":
      return v.parse(response, raw);
    case "agent_start":
      return v.parse(start, raw);
    case "agent_settled":
      return v.parse(settled, raw);
    case "auto_retry_start":
      return v.parse(retry, raw);
    case "message_start":
    case "message_end":
      return v.parse(message, raw);
    case "message_update":
      return v.parse(update, raw);
    case "queue_update":
      return v.parse(queue, raw);
    case "tool_execution_start":
    case "tool_execution_update":
    case "tool_execution_end":
      return v.parse(tool, raw);
    case "extension_ui_request": {
      const { method } = v.parse(v.object({ method: text }), raw);
      if (!ui.entries.method.options.some((m) => m === method)) return null;
      const req = v.parse(ui, raw);
      if (req.method === "select" && !req.options?.length) throw Error("Missing Pi choices");
      return req;
    }
    default:
      return null;
  }
}
export class PiError extends Error {
  constructor(
    readonly reason:
      | "operationRejected"
      | "invalidState"
      | "unsupported"
      | "unsafeToRetry"
      | "requestExpired",
    message: string,
  ) {
    super(message);
  }
}
