import * as v from "valibot";
import {
  REQUEST_METHODS,
  SessionPreviewIdSchema,
  SessionTransitionPreviewSchema,
  type InputContent,
  type SessionTransitionPreview,
  type SignedRequest,
  type NativeSessionId,
} from "@kraka/protocol";
import type { FirstSendStore } from "./first-send-store";
import { readThread } from "./first-send-store";
import type { ThreadSessionBinding } from "./executor-records";
import type { LocalActor } from "./command-receipts";
import { historyAt, selectHandoff } from "./session-history";
export type PreviewInput = Extract<SignedRequest, { method: "thread.previewSession" }>["payload"];
export type ApprovedPreview = Exclude<SessionTransitionPreview, { kind: "reject" }>;
export type SessionIdentity = {
  family: ThreadSessionBinding["family"];
  instanceId: ThreadSessionBinding["instanceId"];
  account: string;
  continuationKey: string;
  checkout: string;
};
export type VerifiedSession = SessionIdentity & {
  nativeSessionId: NativeSessionId;
  model: ApprovedPreview["target"]["model"];
  live: boolean;
};
export type TransitionTarget = {
  target: ApprovedPreview["target"];
  identity: SessionIdentity;
  canResume: boolean;
  modelChange: "now" | "nextTurn" | null;
  acceptsHandoff: boolean;
  acceptsInput: (input: InputContent) => boolean;
  windowTokens: number | null;
  handoffAllowance?: number;
};
export type TransitionFacts = {
  binding: ThreadSessionBinding | null;
  source: VerifiedSession | null;
  target: TransitionTarget | null;
};
const savedSchema = v.strictObject({
  payload: REQUEST_METHODS.previewSession.schema.entries.payload,
  preview: SessionTransitionPreviewSchema,
  identity: v.nullable(v.string()),
});
export function loadPreview(
  store: FirstSendStore,
  id: SessionTransitionPreview["id"],
  actor?: LocalActor["id"],
) {
  const row = store.db
    .query<{ data: string }, [string, string | null, string | null]>(
      "SELECT data FROM session_previews WHERE id=? AND (? IS NULL OR actor=?)",
    )
    .get(id, actor ?? null, actor ?? null);
  return row ? v.parse(savedSchema, JSON.parse(row.data)) : null;
}
export function planSession(
  store: FirstSendStore,
  actor: LocalActor,
  payload: PreviewInput,
  facts: TransitionFacts,
  id: SessionTransitionPreview["id"],
): SessionTransitionPreview {
  const { threadId, sourceRoundId, targetInstanceId, model, expectedBinding, proposedInput } =
    payload;
  const source = sourceRoundId
    ? { environmentId: actor.environmentId, threadId, roundId: sourceRoundId }
    : null;
  const common = { id, threadId, source, expectedBinding };
  function refused(
    reason: Extract<SessionTransitionPreview, { kind: "reject" }>["reason"],
  ): SessionTransitionPreview {
    return { ...common, kind: "reject", reason, targetInstanceId, model };
  }
  if (
    actor.environmentId !== store.writer.environmentId ||
    !actor.allows("thread.view", { kind: "thread", threadId }) ||
    !readThread(store.db, threadId)
  )
    return refused("sourceUnavailable");
  if (!Bun.deepEquals(expectedBinding, facts.binding)) return refused("invalidState");
  const t = facts.target;
  if (!t || t.target.instanceId !== targetInstanceId || !Bun.deepEquals(t.target.model, model))
    return refused("targetUnavailable");
  if (!t.acceptsInput(proposedInput)) return refused("unsupported");
  const history = source ? historyAt(store, actor, source) : null;
  if (source && !history) return refused("sourceUnavailable");
  const selected = selectHandoff(
    history?.entries ?? [],
    proposedInput,
    t.target.catalogVersion,
    t.windowTokens,
    t.handoffAllowance,
  );
  if (!selected.fits) return refused("inputTooLarge");
  const native = facts.source;
  const compatible =
    native &&
    (!expectedBinding ||
      (expectedBinding.nativeSessionId === native.nativeSessionId &&
        expectedBinding.family === native.family &&
        expectedBinding.instanceId === native.instanceId)) &&
    native.family === t.identity.family &&
    native.instanceId === t.identity.instanceId &&
    native.account === t.identity.account &&
    native.checkout === t.identity.checkout &&
    native.continuationKey === t.identity.continuationKey;
  const approved = {
    ...common,
    target: t.target,
    history: history?.coverage ?? { coverage: "unknown" as const, omittedItems: null },
    entries: [],
    budget: selected.budget,
  };
  if (compatible) {
    if (native.live && expectedBinding) {
      if (Bun.deepEquals(native.model, model)) return { ...approved, kind: "reuseSession" };
      if (t.modelChange) return { ...approved, kind: "changeModel", effectiveAt: t.modelChange };
    }
    if (t.canResume)
      return { ...approved, kind: "resumeSession", nativeSessionId: native.nativeSessionId };
  }
  if (!source || !history) return refused("sourceUnavailable");
  if (!t.acceptsHandoff) return refused("unsupported");
  return {
    ...approved,
    kind: "createWithHandoff",
    source,
    entries: selected.entries,
    history: { ...history.coverage, omittedItems: selected.omittedItems },
  };
}
export function previewSessionTransition(
  store: FirstSendStore,
  { actor, ...payload }: PreviewInput & { actor: LocalActor },
  facts: TransitionFacts,
) {
  const id = v.parse(SessionPreviewIdSchema, crypto.randomUUID());
  return store.db.transaction(() => {
    const preview = planSession(store, actor, payload, facts, id);
    if (preview.kind !== "reject")
      store.db.run("INSERT INTO session_previews VALUES(?,?,?)", [
        id,
        actor.id,
        JSON.stringify({
          payload,
          preview,
          identity: facts.target ? JSON.stringify(facts.target.identity) : null,
        }),
      ]);
    return preview;
  })();
}
export function samePreview(
  store: FirstSendStore,
  actor: LocalActor,
  saved: NonNullable<ReturnType<typeof loadPreview>>,
  facts: TransitionFacts,
) {
  return (
    !!facts.target &&
    saved.identity === JSON.stringify(facts.target.identity) &&
    Bun.deepEquals(saved.preview, planSession(store, actor, saved.payload, facts, saved.preview.id))
  );
}
