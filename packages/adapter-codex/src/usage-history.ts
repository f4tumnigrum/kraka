import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import { createInterface } from "node:readline";
import * as v from "valibot";
import type { NativeRootTurnId, NativeSessionId } from "@kraka/protocol";
import { normalizedTokens } from "./account-usage";

const record = v.object({ type: v.string(), payload: v.record(v.string(), v.unknown()) });
function counters(raw: unknown) {
  const fields = v.safeParse(v.record(v.string(), v.unknown()), raw);
  if (!fields.success) return null;
  const t = fields.output;
  return normalizedTokens({
    inputTokens: t.input_tokens,
    cachedInputTokens: t.cached_input_tokens,
    cacheWriteInputTokens: t.cache_write_input_tokens,
    outputTokens: t.output_tokens,
    reasoningOutputTokens: t.reasoning_output_tokens,
    totalTokens: t.total_tokens,
  });
}
export async function* historyUsage(
  history: { path: string; root: string },
  session: NativeSessionId,
  root: NativeRootTurnId,
) {
  const path = await realpath(history.path),
    relativePath = relative(await realpath(history.root), path);
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(".." + sep) ||
    isAbsolute(relativePath)
  )
    return;
  const info = await stat(path);
  if (!info.isFile() || info.size === 0) return;
  const file = await open(
    path,
    constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const actual = await file.stat();
    if (actual.dev !== info.dev || actual.ino !== info.ino || !actual.isFile()) return;
    const input = file.createReadStream({ autoClose: false, end: info.size - 1 });
    const lines = createInterface({ input, crlfDelay: Infinity });
    let verified = false,
      selected = false;
    try {
      for await (const line of lines) {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          continue;
        }
        const parsed = v.safeParse(record, raw);
        if (!parsed.success) continue;
        const { type, payload } = parsed.output;
        if (!verified) {
          if (type !== "session_meta" || payload.id !== session) return;
          verified = true;
          continue;
        }
        if (type === "session_meta") return;
        if (type === "turn_context") {
          selected = payload.turn_id === root;
          continue;
        }
        if (!selected || type !== "event_msg" || payload.type !== "token_count") continue;
        const usage = v.safeParse(
          v.object({ last_token_usage: v.unknown(), total_token_usage: v.unknown() }),
          payload.info,
        );
        if (!usage.success) continue;
        const last = counters(usage.output.last_token_usage),
          total = counters(usage.output.total_token_usage);
        if (last && total)
          yield {
            method: "thread/tokenUsage/updated" as const,
            threadId: session,
            turnId: root,
            last,
            total,
          };
      }
    } finally {
      lines.close();
      input.destroy();
    }
  } finally {
    await file.close();
  }
}
