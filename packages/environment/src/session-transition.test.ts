import { expect, test } from "bun:test";
import * as v from "valibot";
import { MessageIdSchema, AttemptIdSchema, DeliveryIdSchema, RoundIdSchema } from "@kraka/protocol";
import {
  withTransitionStore,
  original,
  tid,
  rid,
  input,
  command,
} from "../../../tools/fixtures/transition-store";
import {
  fixtureTransitionHost,
  peerState,
  proposal,
  type PeerCall,
} from "../../../tools/fixtures/transition-host";
import { SessionBindings } from "./session-binding";
import { clearThreadSession } from "./session-clear";
import { previewSessionTransition } from "./session-preview";
import { readSessionTransition, switchThreadSession } from "./session-transition";
import { forkAtRound, readForkRelationships, reservedForkRound } from "./session-fork";
import { readThread, readRound } from "./first-send-store";
import { fileInputRound, loadQueue } from "./input-store";
import { HandoffDeliveries } from "./session-delivery";
const openEvidence = v.object({
  kind: v.string(),
  cmd: v.optional(
    v.object({ kind: v.string(), request: v.optional(v.object({ kind: v.string() })) }),
  ),
});
function fixture(
  run: (...args: Parameters<Parameters<typeof withTransitionStore>[0]>) => Promise<void>,
) {
  return withTransitionStore(run);
}
function peers(store: Parameters<typeof fixtureTransitionHost>[0], ack = "injected") {
  const calls: string[] = [];
  const call: PeerCall = async (_instance, rpc) => {
    const { kind, cmd } = v.parse(openEvidence, rpc);
    calls.push(cmd?.request?.kind ?? kind);
    if (kind === "open") return "native-beta";
    if (kind === "handle") return original.nativeSessionId;
    if (cmd?.kind === "nativeAction") return "empty-alpha";
    if (cmd?.request?.kind === "handoff") return ack;
    return null;
  };
  const states = new Map(["alpha", "beta"].map((k) => [k, peerState(k)]));
  return { ...fixtureTransitionHost(store, states, call), calls };
}
test("a stale preview cannot replace a newer binding", () =>
  fixture(async (store, actor) => {
    const { host, calls } = peers(store),
      payload = proposal(),
      bindings = new SessionBindings(store, "replacement");
    const preview = previewSessionTransition(
      store,
      { actor, ...payload },
      host.facts(actor, payload),
    );
    expect(await bindings.replace(original, { ...original, epoch: 2 })).toBe(true);
    expect(
      await switchThreadSession(store, host, {
        actor,
        commandId: command("stale"),
        previewId: preview.id,
      }),
    ).toMatchObject({ failure: { kind: "invalidState" } });
    expect(calls).toEqual([]);
    expect(bindings.get(tid)?.epoch).toBe(2);
  }));
test("the current input is never truncated", () =>
  fixture(async (store, actor) => {
    const { host } = peers(store),
      payload = proposal();
    const preview = previewSessionTransition(
      store,
      { actor, ...payload },
      host.facts(actor, payload),
    );
    if (preview.kind !== "createWithHandoff") throw Error(preview.kind);
    expect(preview.entries.map((e) => [e.id, e.version, e.text])).toEqual([
      ["U1", "1", "  initial\n"],
      ["U2", "2", "recent\nquestion"],
      ["A2", "2", "  answer  "],
    ]);
    expect(preview.history).toEqual({ coverage: "complete", missingSources: [], omittedItems: 1 });
    const tooLarge = { ...payload, proposedInput: { ...input, text: "x".repeat(400000) } };
    expect(
      previewSessionTransition(store, { actor, ...tooLarge }, host.facts(actor, tooLarge)),
    ).toMatchObject({ kind: "reject", reason: "inputTooLarge" });
  }));
test("a failed handoff keeps the old binding", () =>
  fixture(async (store, actor) => {
    const { host } = peers(store);
    host.open = async () => null;
    const payload = proposal(),
      op = command("failed"),
      p = previewSessionTransition(store, { actor, ...payload }, host.facts(actor, payload));
    await switchThreadSession(store, host, { actor, previewId: p.id, commandId: op });
    expect(readSessionTransition(store, actor, tid, op)).toMatchObject({
      injection: "failed",
      currentBinding: original,
    });
    expect(new SessionBindings(store, "").get(tid)).toEqual(original);
  }));
test("an unknown injection cannot run twice", () =>
  fixture(async (store, actor) => {
    const { host, calls } = peers(store, "lost"),
      payload = proposal(),
      p = previewSessionTransition(store, { actor, ...payload }, host.facts(actor, payload));
    const args = { actor, previewId: p.id, commandId: command("unknown") };
    expect(await switchThreadSession(store, host, args)).toEqual(
      await switchThreadSession(store, host, args),
    );
    const op = readSessionTransition(store, actor, tid, args.commandId);
    if (op?.kind !== "createWithHandoff" || p.kind !== "createWithHandoff")
      throw Error("Missing transfer");
    const frozen = await new HandoffDeliveries(store).read(op.deliveryId);
    expect(frozen?.handoff.transferId).toBe(op.transferId);
    expect(frozen?.handoffEntries).toEqual(p.entries);
    expect(op.injection).toBe("unknown");
    expect(calls.filter((c) => c === "handoff")).toHaveLength(1);
    expect(calls).not.toContain("input");
  }));
test("a fork preserves its source lineage", () =>
  fixture(async (store, actor) => {
    const ctx = { actor, transaction: store, commandId: command("fork") },
      args = { sourceThreadId: tid, sourceRoundId: rid },
      before = readRound(store.db, rid);
    const receipt = forkAtRound(ctx, args);
    if (receipt.kind !== "accepted" || receipt.result.kind !== "threadForked")
      throw Error("Missing fork");
    const fork = receipt.result.fork;
    expect(forkAtRound(ctx, args)).toEqual(receipt);
    expect(loadQueue(store, fork.targetThreadId).rows).toEqual([]);
    expect(reservedForkRound(store, fork.targetThreadId)).toBe(fork.firstRoundId);
    expect(readForkRelationships(ctx, tid)).toMatchObject({
      result: {
        relationships: [
          {
            kind: "fork",
            targetThreadId: fork.targetThreadId,
            parentThreadId: tid,
            sourceRoundId: rid,
          },
        ],
      },
    });
    expect(readThread(store.db, fork.targetThreadId)?.lineage).toMatchObject({
      kind: "fork",
      sourceRoundId: rid,
    });
    expect(readRound(store.db, rid)).toEqual(before);
  }));
test("clear retains prior thread records", () =>
  fixture(async (store, actor) => {
    const { host } = peers(store),
      jobs: Promise<void>[] = [];
    const prior = readRound(store.db, rid);
    const receipt = clearThreadSession(
      { transaction: store, actor, commandId: command("clear") },
      tid,
      host.clearTarget(actor, tid),
      (job) => jobs.push(job),
    );
    expect(receipt).toMatchObject({ result: { operation: { state: { kind: "accepted" } } } });
    await Promise.all(jobs);
    expect(new SessionBindings(store, "").get(tid)).toMatchObject({
      epoch: 2,
      nativeSessionId: "empty-alpha",
    });
    const round = store.db.transaction(() =>
      fileInputRound(
        store,
        loadQueue(store, tid),
        v.parse(RoundIdSchema, "after-clear"),
        v.parse(MessageIdSchema, "fresh-input"),
        {
          attemptId: v.parse(AttemptIdSchema, "two"),
          deliveryId: v.parse(DeliveryIdSchema, "fresh"),
        },
      ),
    )();
    expect(round.freshContext).toBe(true);
    expect(readRound(store.db, rid)).toEqual(prior);
  }));
