import * as v from "valibot";
import {
  DeliveryIdSchema,
  NativeSessionIdSchema,
  type Round,
  type ForkTransfer,
} from "@kraka/protocol";
import {
  savedBinding,
  readRound,
  readMessage,
  historyAt,
  selectHandoff,
  HandoffDeliveries,
  SessionBindings,
  type FirstSendStore,
  type LocalActor,
  type ExecutorSession,
} from "@kraka/environment";
import { resumeBinding, type PreparedSession } from "./durable-executor";
import type { ExecutorSelection } from "./executor-instances";

export async function prepareForkSession(
  store: FirstSendStore,
  actor: LocalActor,
  fork: ForkTransfer,
  round: Round,
  s: ExecutorSelection,
  current: () => boolean,
): Promise<PreparedSession | null> {
  const child = round.threadId,
    source = fork.source;
  const sourceRound = readRound(store.db, source.roundId),
    message = readMessage(store.db, round.messageId);
  if (
    !message ||
    message.author.kind !== "person" ||
    !sourceRound ||
    sourceRound.threadId !== source.threadId ||
    round.id !== fork.firstRoundId
  )
    return null;
  const permitted = () =>
    current() &&
    actor.allows("thread.send", { kind: "thread", threadId: child }) &&
    actor.allows("thread.view", { kind: "thread", threadId: source.threadId });
  if (!permitted()) return null;
  const history = historyAt(store, actor, source);
  if (!history) return null;
  const saved = savedBinding(store, source.threadId),
    phase = sourceRound.attempt.phase;
  if (phase.kind !== "finished" && phase.kind !== "endedEarly") return null;
  const policy = s.probe.sessionTransition;
  const native =
    saved &&
    saved.nativeSessionId === phase.root.sessionId &&
    saved.instanceId === s.reg.instanceId &&
    saved.family === s.reg.family &&
    saved.context === s.probe.bindingContext &&
    s.snapshot.matrix.forkAtRound.kind !== "unsupported";
  if (!native && (!policy?.handoff || s.snapshot.matrix.startSession.kind === "unsupported"))
    return null;
  const selected = selectHandoff(
    history.entries,
    message,
    s.probe.models?.checkedAt ?? s.snapshot.version,
    policy?.windowTokens?.(s.model) ?? null,
    policy?.handoffAllowance,
  );
  if (!selected.fits) return null;
  const attemptId = round.attempt.attemptId,
    deliveryId = v.parse(DeliveryIdSchema, crypto.randomUUID());
  if (
    !store.db.run("INSERT OR IGNORE INTO fork_dispatch(child,delivery) VALUES(?,?)", [
      child,
      deliveryId,
    ]).changes
  )
    return null;
  let session: ExecutorSession | null = null,
    retained = false;
  try {
    const candidate = await resumeBinding(s, native ? phase.root.sessionId : null, 0, attemptId);
    if (candidate.opened.kind !== "ok") return null;
    session = candidate.opened.value;
    if (
      !session.nativeSessionId ||
      !permitted() ||
      !Bun.deepEquals(history, historyAt(store, actor, source))
    )
      return null;
    const context = {
      source,
      transferId: fork.transferId,
      messageIds: selected.entries.map((e) => e.id),
      history: { ...history.coverage, omittedItems: selected.omittedItems },
    };
    const target = {
      family: s.reg.family,
      instanceId: s.reg.instanceId,
      nativeSessionId: session.nativeSessionId,
      threadId: child,
      attemptId,
      epoch: 1,
    };
    const permit = { capabilityVersion: s.snapshot.version };
    if (native) {
      const support = s.snapshot.matrix.forkAtRound;
      if (support.kind === "unsupported" || session.nativeSessionId !== phase.root.sessionId)
        return null;
      const reply = await session.invoke(
        { ...permit, support },
        {
          kind: "nativeAction",
          action: "fork",
          capability: "forkAtRound",
          deliveryId,
          target: phase.root.id,
        },
      );
      if (
        reply.kind !== "ok" ||
        reply.value.kind !== "nativeBinding" ||
        reply.value.nativeSessionId === phase.root.sessionId
      )
        return null;
      const forkedId = reply.value.nativeSessionId;
      await session.close("finished");
      session = null;
      const childSession = await resumeBinding(s, forkedId, 0, attemptId);
      if (childSession.opened.kind !== "ok") return null;
      session = childSession.opened.value;
      if (session.nativeSessionId !== forkedId) return null;
      target.nativeSessionId = forkedId;
    } else {
      const support = s.snapshot.matrix.startSession;
      if (support.kind === "unsupported") return null;
      const frozen = await new HandoffDeliveries(store).record({
        attemptId,
        deliveryId,
        target,
        messageVersion: message.version,
        input: {
          id: message.id,
          text: message.text,
          attachments: message.attachments,
          references: message.references,
        },
        parts: [],
        handoff: context,
        handoffEntries: selected.entries,
      });
      if (frozen !== "stored" || !permitted()) return null;
      const reader = session.events()[Symbol.asyncIterator]();
      void reader.next().catch(() => {});
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const ack = await Promise.race([
          session.invoke(
            { ...permit, support },
            {
              kind: "service",
              capability: "startSession",
              deliveryId,
              request: { kind: "handoff", ...context, entries: selected.entries },
            },
          ),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), 30000);
          }),
        ]);
        if (
          ack?.kind !== "ok" ||
          ack.value.kind !== "service" ||
          !Bun.deepEquals(ack.value.result, {
            kind: "injected",
            deliveryId,
            transferId: fork.transferId,
            nativeSessionId: target.nativeSessionId,
          })
        )
          return null;
      } finally {
        clearTimeout(timer);
        void reader.return?.().catch(() => {});
      }
    }
    if (!permitted() || session.epoch !== 1) return null;
    const bindings = new SessionBindings(store, s.probe.bindingContext, () =>
      store.db.run(
        "UPDATE session_forks SET data=json_set(data,'$.state','consumed') WHERE child=?",
        [child],
      ),
    );
    if (!(await bindings.replace(null, target))) return null;
    retained = true;
    return { opened: { kind: "ok", value: session }, installed: true };
  } finally {
    if (session && !retained) await session.close("shutdown");
  }
}
