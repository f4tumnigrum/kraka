import { DeliveryIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import {
  readThread,
  savedBinding,
  replaceBinding,
  type RollbackOperationStore,
  type FirstSendStore,
} from "@kraka/environment";
import type { PrincipalId } from "@kraka/protocol";
import { resumeBinding } from "./durable-executor";
import type { ExecutorInstances } from "./executor-instances";
import type { openAccessHost } from "./access";

export function rollbackRuntime(
  store: FirstSendStore,
  executors: ExecutorInstances,
  owner: { readonly id: PrincipalId },
  host: Awaited<ReturnType<typeof openAccessHost>>,
): NonNullable<RollbackOperationStore["runtime"]> {
  return {
    allowed(op, permission) {
      const claimant = op.retryActor ?? { id: op.actor, device: op.device };
      const device = host.store.device(claimant.device);
      const thread = readThread(store.db, op.progress.target.threadId);
      return (
        !!thread &&
        device?.principal.id === claimant.id &&
        device.deviceKey.state.kind === "usable" &&
        device.deviceKey.state.expiresAt > Date.now() &&
        !!host.store.ceiling(claimant.id, { kind: "thread", threadId: thread.id }, permission)
      );
    },
    support(target) {
      const thread = readThread(store.db, target.threadId),
        binding = savedBinding(store, target.threadId);
      if (!thread || !binding) return "unknown";
      const cwd = store.directory(thread) ?? store.projectDirectory(thread.projectId);
      const entry = cwd ? executors.current(binding.instanceId, owner.id, cwd) : null;
      if (!entry) return "unknown";
      return entry.snapshot.matrix.rollbackRounds.kind === "native" ? "verified" : "unsupported";
    },
    async rewind(op, recovery) {
      const { target } = op.progress,
        native = op.native;
      const thread = readThread(store.db, target.threadId),
        prior = savedBinding(store, target.threadId),
        reg = executors.forThread(target.threadId);
      if (
        !thread ||
        !native ||
        !reg ||
        !prior ||
        prior.context !== native.context ||
        prior.nativeSessionId !== native.session
      )
        return recovery ? "unknown" : "failed";
      const s = await executors.resolve(reg, owner.id, thread);
      if (
        !s ||
        s.snapshot.matrix.rollbackRounds.kind !== "native" ||
        s.probe.bindingContext !== native.context ||
        s.reg.family !== prior.family ||
        s.reg.instanceId !== prior.instanceId
      )
        return recovery ? "unknown" : "failed";
      const { opened } = await resumeBinding(s, native.session, prior.epoch, target.attemptId);
      if (opened.kind !== "ok") return recovery ? "unknown" : "failed";
      try {
        if (
          opened.value.nativeSessionId !== native.session ||
          !replaceBinding(store, prior, { ...prior, epoch: opened.value.epoch })
        )
          return recovery ? "unknown" : "failed";
        const result = await opened.value.invoke(
          {
            capabilityVersion: s.snapshot.version,
            support: s.snapshot.matrix.rollbackRounds,
            stillAllowed: () =>
              this.allowed(op, "thread.send") &&
              savedBinding(store, target.threadId)?.epoch === opened.value.epoch,
          },
          {
            kind: "rewind",
            capability: "rollbackRounds",
            deliveryId: v.parse(DeliveryIdSchema, op.progress.commandId),
            roots: native.roots,
            keep: native.keep,
            inspectOnly: recovery,
          },
        );
        return result.kind === "ok" && result.value.kind === "rewind"
          ? result.value.outcome
          : recovery
            ? "unknown"
            : "failed";
      } finally {
        await opened.value.close("finished");
      }
    },
  };
}
