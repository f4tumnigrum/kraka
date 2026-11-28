import { rewindCodex } from "@kraka/adapter-codex";
import {
  readThread,
  savedBinding,
  replaceBinding,
  type RollbackOperationStore,
  type FirstSendStore,
} from "@kraka/environment";
import type { PrincipalId } from "@kraka/protocol";
import { resumeBinding, bindingContext } from "./durable-codex";
import type { CodexInstances } from "./codex-instances";
import type { openAccessHost } from "./access";

export function rollbackRuntime(
  store: FirstSendStore,
  codex: CodexInstances,
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
      const entry = cwd ? codex.current(binding.instanceId, owner.id, cwd) : null;
      if (!entry) return "unknown";
      return entry.snapshot.matrix.rollbackRounds.kind === "native" ? "verified" : "unsupported";
    },
    async rewind(op, recovery) {
      const { target } = op.progress,
        native = op.native;
      const thread = readThread(store.db, target.threadId),
        prior = savedBinding(store, target.threadId),
        reg = codex.forThread(target.threadId);
      if (
        !thread ||
        !native ||
        !reg ||
        !prior ||
        prior.context !== native.context ||
        prior.nativeSessionId !== native.session
      )
        return recovery ? "unknown" : "failed";
      const s = await codex.resolve(reg, owner.id, thread);
      if (
        !s ||
        s.snapshot.matrix.rollbackRounds.kind !== "native" ||
        bindingContext(s) !== native.context
      )
        return recovery ? "unknown" : "failed";
      const { opened, adapter } = await resumeBinding(
        s,
        native.session,
        prior.epoch,
        target.attemptId,
      );
      if (opened.kind !== "ok") return recovery ? "unknown" : "failed";
      try {
        if (
          opened.value.nativeSessionId !== native.session ||
          !replaceBinding(store, prior, { ...prior, epoch: opened.value.epoch })
        )
          return recovery ? "unknown" : "failed";
        return await rewindCodex(
          opened.value.handle,
          native.roots,
          native.keep,
          recovery,
          () =>
            this.allowed(op, "thread.send") &&
            savedBinding(store, target.threadId)?.epoch === opened.value.epoch,
        );
      } finally {
        await adapter.close(opened.value, "finished");
      }
    },
  };
}
