import { forkAtRound, readForkRelationships } from "@kraka/environment";
import type { Handler } from "./context";
export const fork: Handler<"thread.fork"> = (m, c) => {
  const ctx = { actor: c.principal, transaction: c.store, commandId: m.commandId };
  return forkAtRound(ctx, m.payload);
};
export const relationships: Handler<"thread.readRelationships"> = (m, c) => {
  const generation = c.visibility();
  c.disclose(
    readForkRelationships(
      { actor: c.principal, transaction: c.store, commandId: m.commandId },
      m.payload.threadId,
    ),
    () => generation === c.visibility() && c.allows(m.payload.threadId, "thread.view"),
  );
  c.wake();
};
