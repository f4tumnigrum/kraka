import type { Handler } from "./context";
import { readProject, type LocalActor } from "@kraka/environment";
import { REQUEST_METHODS, type CommandReceipt } from "@kraka/protocol";

export const executor: Handler<
  | "executor.startLogin"
  | "executor.readLogin"
  | "executor.cancelLogin"
  | "executor.configure"
  | "executor.refresh"
  | "thread.start"
> = (req, c) => {
  const { loginSession, store, host, executors } = c;
  const actor: LocalActor = {
    ...c.principal,
    allows: (permission, target) => {
      if (!loginSession.active()) return false;
      if (target.kind === "project") {
        if (readProject(store.db, target.projectId)?.environmentId !== host.identity.id)
          return false;
        host.store.provisionProject(target.projectId);
      }
      return !!host.store.ceiling(c.principal.id, target, permission);
    },
  };
  const ctx = { actor, commandId: req.commandId, transaction: store };
  const target =
    req.method === "executor.refresh" || req.method === "thread.start"
      ? { kind: "project" as const, projectId: req.payload.projectId }
      : { kind: "environment" as const, environmentId: actor.environmentId };
  const allowed = () =>
    actor.allows(
      req.method === "executor.refresh"
        ? REQUEST_METHODS.refreshExecutor.permission
        : req.method === "thread.start"
          ? "thread.send"
          : "settings.change",
      target,
    );
  const execute = async (): Promise<CommandReceipt> => {
    if (req.method === "thread.start") return c.startThread(actor, req);
    if (req.method === "executor.configure") return executors.configure(ctx, req.payload);
    if (req.method === "executor.refresh")
      return executors.refresh(ctx, req.payload, loginSession.owner);
    return executors.login.command(ctx, loginSession, req);
  };
  void executors.track(execute()).then(
    (receipt) => {
      if (!c.active()) return;
      if (receipt.kind === "accepted" && allowed()) {
        const result = receipt.result;
        c.disclose(
          receipt,
          () =>
            allowed() &&
            (result.kind !== "instanceLogin" ||
              !result.interaction ||
              store.services.logins.read(
                result.flowId,
                result.instanceId,
                loginSession.id,
                executors.clock.now(),
              )?.phase === result.phase),
        );
      } else
        c.peer.control(
          receipt.kind === "accepted"
            ? { kind: "rejected", commandId: req.commandId, failure: { kind: "notFound" } }
            : receipt,
        );
      c.wake();
    },
    () => c.failed(req.commandId),
  );
};
