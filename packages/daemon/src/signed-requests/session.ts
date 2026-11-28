import {
  clearThreadSession,
  loadPreview,
  previewSessionTransition,
  readSessionTransition,
  SessionBindings,
  switchThreadSession,
} from "@kraka/environment";
import type { CommandReceipt } from "@kraka/protocol";
import type { Handler } from "./context";
export const session: Handler<
  "thread.previewSession" | "thread.switchSession" | "thread.readSessionTransition" | "thread.clear"
> = (m, c) => {
  const { principal, store } = c,
    host = store.services.transitionDriver.current;
  const generation = c.visibility();
  const threadId =
    m.method === "thread.switchSession"
      ? loadPreview(store, m.payload.previewId, principal.id)?.payload.threadId
      : m.payload.threadId;
  const reject = (kind: "invalidState" | "notFound" | "unsupported"): CommandReceipt => ({
    kind: "rejected",
    commandId: m.commandId,
    failure: { kind },
  });
  if (!threadId) return reject("notFound");
  const read = () => c.allows(threadId, "thread.view");
  const disclose = (receipt: CommandReceipt) => {
    if (!c.active()) return;
    c.disclose(receipt, () => generation === c.visibility() && read());
    c.wake();
  };
  if (m.method === "thread.previewSession") {
    if (!read()) return reject("notFound");
    const facts = host?.facts(principal, m.payload) ?? {
      binding: new SessionBindings(store, "").get(threadId),
      source: null,
      target: null,
    };
    disclose({
      kind: "accepted",
      commandId: m.commandId,
      result: {
        kind: "sessionTransitionPreview",
        preview: previewSessionTransition(store, { actor: principal, ...m.payload }, facts),
      },
    });
    return;
  }
  if (m.method === "thread.readSessionTransition") {
    const transition = readSessionTransition(store, principal, threadId, m.payload.operationId);
    if (!transition) return reject("notFound");
    disclose({
      kind: "accepted",
      commandId: m.commandId,
      result: { kind: "sessionTransition", transition },
    });
    return;
  }
  if (!c.allows(threadId, "thread.send")) return reject("notFound");
  const jobs = store.services.transitionJobs;
  if (m.method === "thread.clear") {
    const execute = () =>
      clearThreadSession(
        { actor: principal, transaction: store, commandId: m.commandId },
        threadId,
        host?.clearTarget(principal, threadId) ?? null,
        (job) => {
          jobs.add(job);
          void job.finally(() => jobs.delete(job)).catch(() => {});
        },
      );
    if (!host?.prepare) return execute();
    const job = host.prepare(principal, threadId, null).then(
      () => disclose(execute()),
      () => c.failed(m.commandId),
    );
    jobs.add(job);
    void job.finally(() => jobs.delete(job));
    return;
  }
  if (!host) return reject("unsupported");
  let sent = false;
  const work = switchThreadSession(
    store,
    host,
    {
      actor: principal,
      previewId: m.payload.previewId,
      commandId: m.commandId,
    },
    (receipt) => {
      sent = true;
      disclose(receipt);
    },
  );
  const delivery = work.then(
    (receipt) => {
      if (!sent) disclose(receipt);
    },
    () => c.failed(m.commandId),
  );
  jobs.add(delivery);
  void delivery.finally(() => jobs.delete(delivery)).catch(() => {});
};
