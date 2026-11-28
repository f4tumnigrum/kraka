import type { CommandReceipt, SignedRequest } from "@kraka/protocol";
import type { FirstSendStore, LocalActor } from "@kraka/environment";
import type { Handler } from "./context";

type ForgeRead = Extract<SignedRequest, { method: "forge.account" | "project.repositorySource" }>;
function target(req: ForgeRead, environmentId: LocalActor["environmentId"]) {
  return req.method === "forge.account"
    ? ({ kind: "environment", environmentId } as const)
    : ({ kind: "project", projectId: req.payload.projectId } as const);
}
export async function readForge(
  req: ForgeRead,
  store: FirstSendStore,
  allowed: () => boolean,
): Promise<CommandReceipt> {
  const { commandId } = req;
  const denied = { kind: "rejected", commandId, failure: { kind: "notFound" } } as const;
  if (!allowed()) return denied;
  const { forge } = store.services;
  if (req.method === "forge.account") {
    const account = await forge.accountView(req.payload.host);
    return allowed()
      ? { kind: "accepted", commandId, result: { kind: "forgeAccount", account } }
      : denied;
  }
  const source = await forge.repositorySource(req.payload.projectId);
  return source && allowed()
    ? { kind: "accepted", commandId, result: { kind: "repositorySource", source } }
    : denied;
}
export function forgeReadOnControl(req: ForgeRead, store: FirstSendStore, actor: LocalActor) {
  return readForge(req, store, () => actor.allows("thread.view", target(req, actor.environmentId)));
}
export const forgeRead: Handler<ForgeRead["method"]> = (req, c) => {
  const object = target(req, c.host.identity.id);
  const allowed = () =>
    c.loginSession.active() && !!c.host.store.ceiling(c.principal.id, object, "thread.view");
  void readForge(req, c.store, allowed).then(
    (receipt) => {
      if (!c.active()) return;
      if (receipt.kind === "accepted" && allowed()) c.disclose(receipt, allowed);
      else
        c.peer.control({
          kind: "rejected",
          commandId: req.commandId,
          failure: { kind: "notFound" },
        });
      c.wake();
    },
    () => c.failed(req.commandId),
  );
};
