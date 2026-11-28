import { applyThreadChange, renameThread } from "@kraka/environment";
import type { Handler } from "./context";
export const lifecycle: Handler<"thread.changeLifecycle"> = (m, { principal, store, visibility }) =>
  applyThreadChange(
    { actor: principal, commandId: m.commandId, transaction: store },
    m.payload,
    visibility(),
  );
export const rename: Handler<"thread.rename"> = (m, { principal, allows, store }) =>
  renameThread({
    actor: { ...principal, allows: () => allows(m.payload.threadId, "thread.send") },
    commandId: m.commandId,
    transaction: store,
    ...m.payload,
  });
export const roundControl: Handler<"round.stop" | "round.readStop" | "input.steer"> = (
  m,
  { principal, stopCommand, steerCommand },
) =>
  (m.method === "input.steer" ? steerCommand?.(principal, m) : stopCommand?.(principal, m)) ?? null;
