import * as v from "valibot";
import { NativeRootTurnIdSchema } from "@kraka/protocol";
import type { CodexSessionHandle } from "./adapter";
const history = v.object({
  thread: v.object({
    id: v.string(),
    turns: v.array(v.object({ id: NativeRootTurnIdSchema, status: v.string() })),
  }),
});
export async function rewindCodex(
  handle: CodexSessionHandle,
  expected: readonly string[],
  keep: number,
  recovery: boolean,
  mayWrite: () => boolean,
) {
  const threadId = handle.nativeSessionId;
  function roots(raw: unknown) {
    const { thread } = v.parse(history, raw);
    if (thread.id !== threadId || thread.turns.some((t) => t.status === "inProgress"))
      throw Error("Unverified native history");
    return thread.turns.map((t) => t.id);
  }
  const target = expected.slice(0, keep);
  const seen = roots(await handle.rpc.request("thread/read", { threadId, includeTurns: true }));
  if (Bun.deepEquals(seen, target)) return "succeeded";
  if (recovery) return "unknown";
  if (!Bun.deepEquals(seen, expected) || !mayWrite()) return "failed";
  const after = roots(
    await handle.rpc.request("thread/rollback", { threadId, numTurns: expected.length - keep }),
  );
  return Bun.deepEquals(after, target) ? "succeeded" : "unknown";
}
