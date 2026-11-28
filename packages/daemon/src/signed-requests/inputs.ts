import { applyInputCommand } from "@kraka/environment";
import type { Handler } from "./context";
export const editQueue: Handler<
  "input.editQueued" | "input.cancelQueued" | "input.reorderQueue"
> = (m, { session, principal, store, allows }) =>
  session.features.includes("queueEditing")
    ? applyInputCommand({
        actor: { ...principal, allows: (right) => allows(m.payload.threadId, right) },
        transaction: store,
        command: m,
      })
    : null;
export const input: Handler<"input.send"> = (
  m,
  {
    allows,
    principal,
    fixtureCommand,
    store,
    sendInput,
    schedule,
    active,
    peer,
    wake,
    beforeInputReceipt,
    failed,
  },
) => {
  const permitted = () => allows(m.payload.threadId, "thread.send");
  const injected = permitted() ? fixtureCommand?.(m, store) : null;
  if (injected) return injected;
  void sendInput({ ...principal, allows: permitted }, m).then(
    (receipt) => {
      if (receipt.kind === "accepted") schedule(m.payload.threadId, m.commandId);
      const deliver = () => {
        if (active()) {
          peer.control(receipt);
          wake();
        }
      };
      if (beforeInputReceipt) beforeInputReceipt(m, receipt, deliver);
      else deliver();
    },
    () => failed(m.commandId),
  );
};
