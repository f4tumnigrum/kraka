import * as v from "valibot";
import {
  ChildModelSchema,
  ThreadIdSchema,
  type ThreadId,
  type PrincipalId,
  type ExecutorInstanceId,
  type RoundId,
} from "@kraka/protocol";
import {
  visibleRegistration,
  readImportedSessionSource,
  readThread,
  SessionBindings,
  type TransitionHost,
  type TransitionChannel,
  type ExecutorSession,
  type FirstSendStore,
  type TransitionFacts,
} from "@kraka/environment";
import type { ExecutorInstances, ExecutorSelection } from "./executor-instances";
import { resumeBinding, type PreparedSession } from "./durable-executor";
export function executorTransitions(
  store: FirstSendStore,
  instances: ExecutorInstances,
  ready: (round: RoundId, session: PreparedSession, thread: ThreadId) => void,
): TransitionHost {
  const bindings = new SessionBindings(store, "");
  const opened = new WeakMap<TransitionChannel, ExecutorSession>();
  function selection(
    actor: PrincipalId,
    threadId: ThreadId,
    id: ExecutorInstanceId,
    model: Parameters<ExecutorInstances["select"]>[1],
  ) {
    const thread = readThread(store.db, threadId),
      cwd = thread && store.directory(thread);
    if (!cwd) return null;
    const entry = instances.current(id, actor, cwd);
    return entry?.reg.enabled ? instances.select(entry, model) : null;
  }
  function wrap(s: ExecutorSelection, session: ExecutorSession) {
    const channel: TransitionChannel = {
      context: s.probe.bindingContext,
      declaration: s.probe.declaration,
      session: { ...session, handle: session },
      adapter: {
        events: () => session.events(),
        invoke: (_session, permit, cmd) => session.invoke(permit, cmd),
        close: (_session, reason) => session.close(reason),
      },
    };
    opened.set(channel, session);
    return channel;
  }
  return {
    async prepare(actor, threadId, instance) {
      const thread = readThread(store.db, threadId);
      if (!thread || !actor.allows("thread.view", { kind: "thread", threadId })) return;
      const ids = new Set([instance, bindings.get(threadId)?.instanceId]);
      for (const id of ids)
        if (id)
          await instances.lookup(id, actor.id, thread.projectId, () => store.directory(thread));
    },
    authorized(actor, p) {
      return !!visibleRegistration(instances.registry.current(p.targetInstanceId), actor.id);
    },
    facts(actor, p) {
      const old = bindings.latest(p.threadId),
        binding = bindings.get(p.threadId),
        reg = instances.forThread(p.threadId);
      const oldModel = reg && v.parse(ChildModelSchema, JSON.parse(reg.model));
      const s = old && oldModel && selection(actor.id, p.threadId, old.instanceId, oldModel);
      const t = selection(actor.id, p.threadId, p.targetInstanceId, p.model);
      const policy = t?.probe.sessionTransition;
      const prior = s && s.probe.sessionTransition;
      const imported = !old ? readImportedSessionSource(store, p.threadId) : null;
      const source: TransitionFacts["source"] =
        old && oldModel && s && prior && old.context === s.probe.bindingContext
          ? {
              family: s.reg.family,
              instanceId: s.reg.instanceId,
              nativeSessionId: old.nativeSessionId,
              account: prior.account,
              continuationKey: prior.continuationKey,
              checkout: s.cwd,
              model: oldModel,
              live: !!prior.hasLive?.(old),
            }
          : imported
            ? { ...imported, live: false }
            : null;
      if (!t || !policy || !t.probe.models) return { binding, source, target: null };
      const matrix = t.snapshot.matrix;
      return {
        binding,
        source,
        target: {
          target: {
            family: t.reg.family,
            instanceId: t.reg.instanceId,
            account: policy.account,
            model: t.model,
            configurationVersion: t.reg.version,
            capabilityVersion: t.snapshot.version,
            catalogVersion: t.probe.models.checkedAt,
            permission: t.snapshot.permission,
          },
          identity: {
            family: t.reg.family,
            instanceId: t.reg.instanceId,
            account: policy.account,
            continuationKey: policy.continuationKey,
            checkout: t.cwd,
          },
          canResume: matrix.resumeSessionAfterProcessExit.kind !== "unsupported",
          modelChange: matrix.changeModel.kind === "unsupported" ? null : policy.modelChange,
          acceptsHandoff: policy.handoff && matrix.startSession.kind !== "unsupported",
          windowTokens: policy.windowTokens?.(p.model) ?? null,
          ...(policy.handoffAllowance !== undefined
            ? { handoffAllowance: policy.handoffAllowance }
            : {}),
          acceptsInput: (content) =>
            !content.references.length &&
            matrix.submitTextInput.kind !== "unsupported" &&
            content.attachments.every(
              (a) =>
                (a.kind === "image" ? matrix.submitImageInput : matrix.submitFileInput).kind !==
                "unsupported",
            ),
        },
      };
    },
    async open(p, attempt, actor) {
      const s = selection(actor.id, p.threadId, p.target.instanceId, p.target.model);
      if (
        !s ||
        s.reg.version !== p.target.configurationVersion ||
        s.snapshot.version !== p.target.capabilityVersion
      )
        return null;
      if (p.kind === "reuseSession" || p.kind === "changeModel") {
        const live =
          p.expectedBinding &&
          (await s.probe.sessionTransition?.live?.(p.expectedBinding, attempt));
        return live ? wrap(s, live) : null;
      }
      const { opened } = await resumeBinding(
        s,
        p.kind === "resumeSession" ? p.nativeSessionId : null,
        p.expectedBinding?.epoch ?? 0,
        attempt,
      );
      return opened.kind === "ok" ? wrap(s, opened.value) : null;
    },
    clearTarget(actor, threadId) {
      const old = bindings.latest(threadId),
        reg = instances.forThread(threadId);
      if (!old || !reg) return null;
      const s = selection(
        actor.id,
        threadId,
        old.instanceId,
        v.parse(ChildModelSchema, JSON.parse(reg.model)),
      );
      if (
        !s ||
        old.context !== s.probe.bindingContext ||
        s.snapshot.matrix.clearSession.kind === "unsupported"
      )
        return null;
      return {
        current: () =>
          actor.allows("thread.send", { kind: "thread", threadId }) &&
          instances.current(s.reg.instanceId, actor.id, s.cwd)?.snapshot === s.snapshot &&
          Bun.deepEquals(bindings.latest(threadId), old),
        async open() {
          const candidate = await resumeBinding(s, old.nativeSessionId, old.epoch, old.attemptId);
          return candidate.opened.kind === "ok" ? wrap(s, candidate.opened.value) : null;
        },
      };
    },
    ready(channel, round) {
      const session = opened.get(channel);
      if (!session) throw Error("Missing verified session");
      opened.delete(channel);
      const row = store.db
        .query<{ thread: string }, [string]>(
          "SELECT json_extract(data,'$.threadId') thread FROM rounds WHERE id=?",
        )
        .get(round);
      if (!row) throw Error("Missing accepted round");
      ready(
        round,
        { opened: { kind: "ok", value: session }, installed: true },
        v.parse(ThreadIdSchema, row.thread),
      );
    },
  };
}
