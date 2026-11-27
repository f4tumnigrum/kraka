import * as v from "valibot";
import { AdapterFamilySchema } from "@kraka/protocol";
import type { AdapterJsonValue } from "@kraka/environment";
import { assertFakeCredentials } from "./fixture-credentials";

const text = v.pipe(v.string(), v.minLength(1));
export const ExecutorHeaderSchema = v.strictObject({
  kind: v.literal("header"),
  family: AdapterFamilySchema,
  protocol: text,
  sourceRevision: text,
  scenario: text,
  description: text,
});
// Leave the parsed native frame intact, including fields whose meaning belongs to its adapter.
function isJson(value: unknown): value is AdapterJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return (
    typeof value === "object" &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every(isJson)
  );
}
export const ExecutorFrameSchema = v.strictObject({
  kind: v.literal("frame"),
  seq: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  direction: v.picklist(["toExecutor", "fromExecutor"]),
  channel: v.picklist(["stdio", "http", "sse", "sdk"]),
  frame: v.custom<AdapterJsonValue>(isJson),
});
export type ExecutorHeader = v.InferOutput<typeof ExecutorHeaderSchema>;
export type ExecutorFrame = v.InferOutput<typeof ExecutorFrameSchema>;

export function parseExecutorSample(source: string): {
  header: ExecutorHeader;
  frames: ExecutorFrame[];
} {
  const lines = source.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  if (!lines.length) throw new Error("Expected a header at EOF at line 1");
  function row(index: number): unknown {
    const line = lines[index];
    if (!line?.trim()) throw new Error(`Empty JSONL row at line ${index + 1}`);
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Invalid JSON at line ${index + 1}`);
    }
    assertFakeCredentials(value, `line ${index + 1}`);
    return value;
  }
  function envelope<S extends v.GenericSchema>(
    schema: S,
    index: number,
    kind: string,
  ): v.InferOutput<S> {
    const parsed = v.safeParse(schema, row(index));
    if (!parsed.success)
      throw new Error(`Invalid ${kind} at line ${index + 1} (${parsed.issues[0].type})`);
    return parsed.output;
  }
  const header = envelope(ExecutorHeaderSchema, 0, "header");
  if (lines.length === 1) throw new Error("Expected a frame at EOF at line 2");
  const frames = lines.slice(1).map((_, i) => {
    const frame = envelope(ExecutorFrameSchema, i + 1, "frame");
    if (frame.seq !== i + 1) throw new Error(`Unexpected frame sequence at line ${i + 2}`);
    return frame;
  });
  return { header, frames };
}
