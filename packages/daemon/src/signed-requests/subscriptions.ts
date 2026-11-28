import type { Handler } from "./context";
export const git: Handler<"git.readStatus" | "git.subscribeStatus"> = (m, { gitStatus }) =>
  gitStatus.handle(m);
export const subscription: Handler<
  | "history.pageSaved"
  | "subscription.close"
  | "subscription.gap"
  | "subscription.installed"
  | "subscription.openList"
  | "subscription.openThread"
  | "subscription.pageSaved"
  | "thread.markRead"
  | "thread.readEarlierSettled"
  | "thread.readHistory"
  | "tool.readActivity"
> = (m, { subs, gitStatus }) => {
  if (m.method === "subscription.close" || m.method === "subscription.gap") {
    const receipt = gitStatus.handle(m);
    if (receipt) return receipt;
  }
  if (
    (m.method === "subscription.openThread" ||
      m.method === "subscription.openList" ||
      m.method === "tool.readActivity") &&
    gitStatus.has(m.payload.subscriptionId)
  )
    return { kind: "rejected", commandId: m.commandId, failure: { kind: "invalidState" } };
  return subs.handle(m);
};
