import * as v from "valibot";
import { savedBinding, replaceBinding } from "./executor-bindings";
import { SessionBindingSchema, type ThreadId } from "@kraka/protocol";
import type { ThreadBindingStore, ThreadSessionBinding } from "./executor-records";
import type { FirstSendStore } from "./first-send-store";
const stored = v.object({ ...SessionBindingSchema.entries, context: v.string() });
export class SessionBindings implements ThreadBindingStore {
  constructor(
    readonly store: FirstSendStore,
    readonly context: string,
    readonly onReplace?: (next: ThreadSessionBinding) => void,
  ) {}
  latest(threadId: ThreadId) {
    return savedBinding(this.store, threadId);
  }
  get(threadId: ThreadId): ThreadSessionBinding | null {
    const saved = this.latest(threadId);
    if (!saved) return null;
    const { context, ...binding } = saved;
    return binding;
  }
  async current(threadId: ThreadId) {
    return this.get(threadId);
  }
  async history(threadId: ThreadId) {
    return this.store.db
      .query<{ data: string }, [string]>(
        "SELECT data FROM codex_bindings WHERE thread=? ORDER BY epoch",
      )
      .all(threadId)
      .map((r) => {
        const { context, ...binding } = v.parse(stored, JSON.parse(r.data));
        return binding;
      });
  }
  async replace(expected: ThreadSessionBinding | null, next: ThreadSessionBinding) {
    return this.store.db.transaction(() => {
      if (
        next.epoch !== (expected?.epoch ?? 0) + 1 ||
        !Bun.deepEquals(this.get(next.threadId), expected)
      )
        return false;
      if (
        !next.nativeSessionId ||
        !replaceBinding(this.store, this.latest(next.threadId), {
          ...next,
          nativeSessionId: next.nativeSessionId,
          context: this.context,
        })
      )
        return false;
      this.onReplace?.(next);
      return true;
    })();
  }
}
