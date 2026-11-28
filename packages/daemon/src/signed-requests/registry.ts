import { compact } from "./context-operations";
import { rollback } from "./rollback";
import { checkpoint } from "./checkpoint";
import { editQueue, input } from "./inputs";
import { lifecycle, rename, roundControl } from "./threads";
import { git, subscription } from "./subscriptions";
import { todo } from "./todos";
import { executor } from "./executor";
import { settings } from "./settings";
import type { Request, RequestContext } from "./context";
import type { CommandReceipt } from "@kraka/protocol";

function matches<M extends Request["method"]>(
  req: Request,
  name: M,
): req is Extract<Request, { method: M }> {
  return req.method === name;
}
function route<M extends Request["method"]>(
  name: M,
  handle: (
    req: Extract<Request, { method: NoInfer<M> }>,
    c: RequestContext,
  ) => CommandReceipt | null | void,
) {
  return [
    name,
    (req: Request, c: RequestContext) => {
      if (matches(req, name)) return handle(req, c);
      throw Error("Mismatched signed request");
    },
  ] as const;
}
const routes = new Map<
  Request["method"],
  (req: Request, c: RequestContext) => CommandReceipt | null | void
>([
  route("checkpoint.diff", checkpoint),
  route("checkpoint.previewRollback", rollback),
  route("checkpoint.readRollbackPart", rollback),
  route("checkpoint.restoreFiles", rollback),
  route("checkpoint.retryDialogue", rollback),
  route("checkpoint.retryFiles", rollback),
  route("checkpoint.rollback", rollback),
  route("checkpoint.rollbackDialogue", rollback),
  route("executor.cancelLogin", executor),
  route("executor.configure", executor),
  route("executor.readLogin", executor),
  route("executor.refresh", executor),
  route("executor.startLogin", executor),
  route("git.readStatus", git),
  route("git.subscribeStatus", git),
  route("history.pageSaved", subscription),
  route("input.cancelQueued", editQueue),
  route("input.editQueued", editQueue),
  route("input.reorderQueue", editQueue),
  route("input.send", input),
  route("input.steer", roundControl),
  route("round.readStop", roundControl),
  route("round.stop", roundControl),
  route("settings.read", settings),
  route("settings.write", settings),
  route("subscription.close", subscription),
  route("subscription.gap", subscription),
  route("subscription.installed", subscription),
  route("subscription.openList", subscription),
  route("subscription.openThread", subscription),
  route("subscription.pageSaved", subscription),
  route("thread.changeLifecycle", lifecycle),
  route("thread.compact", compact),
  route("thread.markRead", subscription),
  route("thread.readEarlierSettled", subscription),
  route("thread.readHistory", subscription),
  route("thread.rename", rename),
  route("thread.start", executor),
  route("todo.answer", todo),
  route("todo.decide", todo),
  route("todo.readAnswer", todo),
  route("todo.readSecretReceipt", todo),
  route("todo.submitSecret", todo),
  route("tool.readActivity", subscription),
]);
export function dispatch(req: Request, c: RequestContext) {
  const handler = routes.get(req.method);
  return handler ? handler(req, c) : null;
}
