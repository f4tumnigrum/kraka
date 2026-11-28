import { readThreadUsage } from "@kraka/environment";
import type { Handler } from "./context";

export const threadUsage: Handler<"thread.readUsage"> = (request, { store, allows, disclose }) => {
  const {
    commandId,
    payload: { threadId },
  } = request;
  const allowed = () => allows(threadId, "thread.view");
  if (!allowed()) return { kind: "rejected", commandId, failure: { kind: "notFound" } };
  disclose({ kind: "accepted", commandId, result: readThreadUsage(store, threadId) }, allowed);
};
