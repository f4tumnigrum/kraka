// Live cases 6; required groups ["1.", "2.", "3.", "4.", "5.", "6."]
import { expect, test } from "bun:test";
import { withSessionDaemon } from "../fixtures/session-transition-daemon";
import { original, tid, rid, input } from "../fixtures/transition-store";
import { proposal } from "../fixtures/transition-host";
import { accepted } from "../fixtures/first-send";
import {
  SessionBindings,
  HandoffDeliveries,
  inputHistory,
  readRound,
  readThread,
} from "@kraka/environment";
test("1. compatible continuation reuses, changes model or resumes the verified native session", async () => {
  for (const scenario of ["reuseSession", "changeModel", "resumeSession", "unavailable"] as const) {
    await withSessionDaemon(async (f) => {
      if (scenario === "resumeSession") await f.revise("alpha", { live: false });
      if (scenario === "unavailable") await f.revise("alpha", { available: false });
      const payload = proposal("alpha");
      if (scenario === "changeModel") payload.model.id += "-new";
      const p = await f.preview(payload);
      if (scenario === "unavailable") {
        expect(p).toMatchObject({ kind: "reject", reason: "targetUnavailable" });
        expect(await f.ledger("alpha")).toEqual([]);
        return;
      }
      expect(p.kind).toBe(scenario);
      if (p.kind === "changeModel") expect(p.effectiveAt).toBe("nextTurn");
      accepted(await f.switch(p.id), "sessionSwitchAccepted");
      expect(await f.read()).toMatchObject({
        kind: scenario,
        target: { model: payload.model },
        currentBinding: { threadId: tid, nativeSessionId: original.nativeSessionId },
      });
      await f.waitForInput("alpha");
      const ledger = await f.ledger("alpha");
      expect(ledger.filter((e) => e.kind === "open")).toEqual(
        scenario === "resumeSession"
          ? [expect.objectContaining({ resume: original.nativeSessionId })]
          : [],
      );
      expect(ledger.at(-1)).toMatchObject({
        kind: "input",
        text: input.text,
        nativeSessionId: original.nativeSessionId,
      });
    });
  }
}, 30000);
test(
  "2. preview and portable handoff deliver the same ordered text",
  () =>
    withSessionDaemon(async (f) => {
      const p = await f.preview();
      if (p.kind !== "createWithHandoff") throw Error(p.kind);
      expect(p.entries.map((e) => String(e.id))).toEqual(["U1", "U2", "A2"]);
      expect(await f.ledger("beta")).toEqual([]);
      accepted(await f.switch(p.id), "sessionSwitchAccepted");
      const op = await f.read();
      if (op.kind !== "createWithHandoff") throw Error(op.kind);
      expect(op).toMatchObject({
        injection: "injected",
        threadId: tid,
        currentBinding: { instanceId: "beta", epoch: 2 },
      });
      await f.waitForInput("beta");
      const ledger = await f.ledger("beta");
      expect(ledger.map((e) => e.kind)).toEqual([
        "open",
        "subscribe",
        "invoke",
        "subscribe",
        "input",
      ]);
      expect(ledger[2]?.cmd).toMatchObject({
        deliveryId: op.deliveryId,
        request: { entries: p.entries, transferId: op.transferId },
      });
      expect(ledger.at(-1)).toMatchObject({ text: input.text });
      await f.revise("alpha", { handoff: false });
      const unsupported = await f.preview({
        ...proposal(),
        targetInstanceId: original.instanceId,
        model: { id: "model-alpha", options: {} },
        expectedBinding: op.currentBinding,
      });
      expect(unsupported).toMatchObject({ kind: "reject", reason: "unsupported" });
    }),
  15000,
);
test(
  "3. stale target revisions refuse the preview without an injection",
  () =>
    withSessionDaemon(async (f) => {
      const p = await f.preview();
      await f.revise("beta", { handoff: false });
      expect(await f.switch(p.id)).toMatchObject({
        kind: "rejected",
        failure: { kind: "invalidState" },
      });
      expect(await f.preview()).toMatchObject({ kind: "reject", reason: "unsupported" });
      expect(new SessionBindings(f.store, "").get(tid)).toEqual(original);
      expect(await f.ledger("beta")).toEqual([]);
    }),
  15000,
);
test(
  "4. a fork from a completed round reserves its first real input",
  () =>
    withSessionDaemon(async (f) => {
      const parent = readRound(f.store.db, rid);
      const { fork } = accepted(
        await f.client.rpc("thread.fork", { sourceThreadId: tid, sourceRoundId: rid }),
        "threadForked",
      );
      const child = fork.targetThreadId;
      expect(child).not.toBe(tid);
      expect(inputHistory(f.store, child).rounds).toHaveLength(0);
      expect(
        accepted(
          await f.client.rpc("thread.readRelationships", { threadId: child }),
          "threadRelationships",
        ).fork,
      ).toEqual(fork);
      expect(
        accepted(
          await f.client.rpc("thread.readRelationships", { threadId: tid }),
          "threadRelationships",
        ).relationships,
      ).toContainEqual({
        kind: "fork",
        parentThreadId: tid,
        sourceRoundId: rid,
        targetThreadId: child,
        sideChat: false,
      });
      expect(
        accepted(
          await f.client.rpc("input.send", { threadId: child, content: input }),
          "inputScheduled",
        ).roundId,
      ).toBe(fork.firstRoundId);
      await f.waitForInput("alpha");
      expect(
        accepted(
          await f.client.rpc("thread.readRelationships", { threadId: child }),
          "threadRelationships",
        ).fork?.state,
      ).toBe("consumed");
      expect(inputHistory(f.store, child).rounds.map((r) => r.id)).toEqual([fork.firstRoundId]);
      expect(readRound(f.store.db, rid)).toEqual(parent);
    }),
  15000,
);
test(
  "5. clear commits a new binding and marks only the next round fresh",
  () =>
    withSessionDaemon(async (f) => {
      const prior = readRound(f.store.db, rid),
        directory = readThread(f.store.db, tid)?.directory;
      const receipt = accepted(
        await f.client.rpc("thread.clear", { threadId: tid }),
        "contextOperation",
      );
      expect(receipt.operation.state.kind).toBe("accepted");
      await Promise.all(f.store.services.transitionJobs);
      const binding = new SessionBindings(f.store, "").get(tid);
      expect(binding?.nativeSessionId).not.toBe(original.nativeSessionId);
      expect((await f.ledger("alpha")).map((e) => e.kind)).toEqual(["open", "subscribe", "invoke"]);
      const op = f.store.sync.read(
        {
          threadId: tid,
          environmentId: f.store.writer.environmentId,
          canRead: () => true,
          protocolMinor: 2,
          timelineItems: false,
        },
        "test",
      ).contextOperations;
      expect(op).toContainEqual(
        expect.objectContaining({
          operation: expect.objectContaining({
            deliveryId: receipt.operation.deliveryId,
            state: expect.objectContaining({
              kind: "completed",
              nativeSessionId: binding?.nativeSessionId,
            }),
          }),
        }),
      );
      const scheduled = accepted(
        await f.client.rpc("input.send", { threadId: tid, content: input }),
        "inputScheduled",
      );
      await f.waitForInput("alpha");
      const sent = await f.ledger("alpha");
      expect(sent.filter((e) => e.kind === "input")).toEqual([
        { kind: "input", text: input.text, nativeSessionId: binding?.nativeSessionId },
      ]);
      expect(sent.filter((e) => e.kind === "invoke")).toHaveLength(1);
      expect(readRound(f.store.db, scheduled.roundId)?.freshContext).toBe(true);
      expect(readRound(f.store.db, rid)).toEqual(prior);
      expect(readThread(f.store.db, tid)?.directory).toEqual(directory);
    }),
  15000,
);
test(
  "6. an unknown injection survives restart with the original frozen bytes",
  () =>
    withSessionDaemon(async (f) => {
      await f.revise("beta", { drop: true });
      const p = await f.preview();
      if (p.kind !== "createWithHandoff") throw Error(p.kind);
      const receipt = await f.switch(p.id),
        op = await f.read();
      if (op.kind !== "createWithHandoff") throw Error(op.kind);
      await f.restart();
      f.store.db.run(
        "UPDATE messages SET data=json_set(data,'$.text','changed','$.version','3') WHERE id='A2'",
      );
      expect(await f.switch(p.id)).toEqual(receipt);
      expect(await f.read()).toEqual(op);
      expect(op.injection).toBe("unknown");
      expect(op.currentBinding).toEqual(original);
      const frozen = await new HandoffDeliveries(f.store).read(op.deliveryId);
      expect(frozen?.handoffEntries).toEqual(p.entries);
      const ledger = await f.ledger("beta");
      expect(ledger.filter((e) => e.kind === "invoke")).toEqual([
        expect.objectContaining({
          cmd: expect.objectContaining({
            deliveryId: op.deliveryId,
            request: expect.objectContaining({ entries: p.entries, transferId: op.transferId }),
          }),
        }),
      ]);
      expect(ledger.filter((e) => e.kind === "input")).toEqual([]);
    }),
  15000,
);
