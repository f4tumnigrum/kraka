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

export const accountQuota: Handler<"executor.readQuota" | "executor.refreshQuota"> = (m, c) => {
  const service = c.accountQuota,
    id = m.payload.instanceId,
    allowed = c.allowsEnvironmentView;
  const target = { kind: "environment", environmentId: c.host.identity.id } as const;
  if (!allowed())
    return {
      kind: "rejected",
      commandId: m.commandId,
      failure: { kind: "missingPermission", target, permission: "thread.view" },
    };
  if (!service)
    return { kind: "rejected", commandId: m.commandId, failure: { kind: "unsupported" } };
  const resolve = () => (allowed() ? service.target(id) : null);
  const execute = async () => {
    const subscribe = m.method === "executor.readQuota" ? m.payload.subscribe : undefined;
    if (m.method === "executor.refreshQuota" || subscribe === true)
      await service.prepare(id, c.principal.id);
    if (!c.active()) return;
    if (subscribe !== undefined) {
      c.quotaViews.get(id)?.();
      c.quotaViews.delete(id);
    }
    const snapshot =
      m.method === "executor.refreshQuota" && allowed()
        ? await service.refreshes.refresh(() => service.target(id))
        : service.refreshes.read(resolve);
    if (!c.active()) return;
    const matches = () =>
      allowed() && !!snapshot && sameSource(resolve()?.binding.source, snapshot.source);
    if (!snapshot || !matches()) {
      c.peer.control({ kind: "rejected", commandId: m.commandId, failure: { kind: "notFound" } });
      c.wake();
      return;
    }
    c.disclose(
      { kind: "accepted", commandId: m.commandId, result: { kind: "accountQuota", snapshot } },
      matches,
    );
    if (subscribe === true) {
      let initial = true;
      c.quotaViews.set(
        id,
        service.refreshes.subscribe(resolve, (committed) => {
          if (initial) {
            initial = false;
            return;
          }
          if (!allowed() || !c.active()) return;
          c.peer.control({
            kind: "executor.quotaChanged",
            source: committed.source,
            version: committed.version,
          });
          c.wake();
        }),
      );
    }
    c.wake();
  };
  void execute().catch(() => c.failed(m.commandId));
};
function sameSource(
  current: import("@kraka/protocol").AccountQuotaSnapshot["source"] | undefined,
  observed: import("@kraka/protocol").AccountQuotaSnapshot["source"],
) {
  return (
    current?.instanceId === observed.instanceId &&
    current.account === observed.account &&
    current.credentialVersion === observed.credentialVersion &&
    current.endpoint === observed.endpoint
  );
}
