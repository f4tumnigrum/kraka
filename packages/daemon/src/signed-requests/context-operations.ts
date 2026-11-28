import * as v from "valibot";
import { recordCommand, savedBinding } from "@kraka/environment";
import {
  ContextOperationSchema,
  REQUEST_METHODS,
  type CommandReceipt,
  type ContextOperationObservation,
} from "@kraka/protocol";
import type { Handler } from "./context";
export const compact: Handler<"thread.compact"> = (m, { store, principal }) => {
  const { threadId, instructions } = m.payload,
    service = store.services.context;
  const target = { kind: "thread" as const, threadId };
  let dispatch: (() => Promise<void>) | undefined;
  const receipt = recordCommand(
    { actor: principal, commandId: m.commandId, transaction: store },
    REQUEST_METHODS.compactThread,
    m.payload,
    target,
    () => {
      const binding = savedBinding(store, threadId),
        endpoint = service.live.get(threadId);
      const reject = (kind: "notFound" | "unsupported" | "invalidState"): CommandReceipt => ({
        kind: "rejected",
        commandId: m.commandId,
        failure: { kind },
      });
      if (!binding) return reject("notFound");
      if (!endpoint || endpoint.support.kind === "unsupported") return reject("unsupported");
      if (
        !endpoint.current() ||
        binding.epoch !== endpoint.binding.epoch ||
        binding.attemptId !== endpoint.binding.attemptId ||
        binding.nativeSessionId !== endpoint.binding.nativeSessionId ||
        binding.instanceId !== endpoint.binding.instanceId ||
        binding.family !== endpoint.binding.family
      )
        return reject("invalidState");
      const operation = v.parse(ContextOperationSchema, {
        action: "compact",
        threadId,
        deliveryId: crypto.randomUUID(),
        version: "1",
        state: { kind: "accepted", acceptedAt: Date.now() },
      });
      store.sync.record([], { context: operation });
      dispatch = async () => {
        service.register(operation.deliveryId, endpoint);
        let observed: ContextOperationObservation;
        try {
          observed = await endpoint.invoke(operation.deliveryId, instructions);
        } catch {
          observed = {
            action: "compact",
            threadId,
            deliveryId: operation.deliveryId,
            state: { kind: "unknown", observedAt: Date.now() },
          };
        }
        if (
          observed.deliveryId === operation.deliveryId &&
          observed.threadId === threadId &&
          observed.action === "compact"
        )
          service.observe(observed, endpoint);
      };
      return { kind: "contextOperation", operation };
    },
  );
  if (dispatch) {
    const job = dispatch();
    service.active.add(job);
    void job.finally(() => service.active.delete(job)).catch(() => {});
  }
  return receipt;
};
