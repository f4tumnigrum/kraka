import { RoundSchema } from "@kraka/protocol";
import * as v from "valibot";
import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import dropScenario from "../fixtures/scenarios/dropping-an-unknown-input-keeps-its-late-receipt.json";
import heldScenario from "../fixtures/scenarios/human-queue-waits-for-release-after-restart.json";
import { accepted } from "./fixtures/first-send";
import { withInputPeer } from "./fixtures/input-recovery";

function scenarioPhase(fixture: unknown, after: string, id: string) {
  const match = v
    .parse(
      v.object({
        clients: v.array(
          v.object({
            expected: v.array(v.object({ after: v.string(), messages: v.array(v.unknown()) })),
          }),
        ),
      }),
      fixture,
    )
    .clients[0]?.expected.find((item) => item.after === after);
  for (const message of match?.messages ?? []) {
    const batch = v.safeParse(v.object({ changes: v.array(v.unknown()) }), message);
    if (!batch.success) continue;
    for (const change of batch.output.changes) {
      const row = v.safeParse(
        v.object({ object: v.object({ objectType: v.literal("round"), value: RoundSchema }) }),
        change,
      );
      if (row.success && row.output.object.value.id === id)
        return row.output.object.value.attempt.phase;
    }
  }
  throw Error("Expected saved scenario observation " + after);
}
test(
  "1 S-STATE-014 an external write stays uncertain and a numbered resend creates one attempt",
  () =>
    withInputPeer(
      async (f) => {
        const original = await f.start(),
          { threadId, attemptId, deliveryId, roundId } = original;
        await f.seen("afterWrite", deliveryId);
        await f.restart();
        const history = await f.client.readInputHistory(threadId);
        expect(history.rounds[0]?.attempt).toEqual({
          attemptId,
          deliveryId,
          phase: { kind: "uncertain", next: "inspectInput" },
        });
        expect((await f.client.send("input.releaseQueue", { threadId })).receipt).toMatchObject({
          failure: { kind: "queueHeld" },
        });
        expect((await f.ledger()).filter((e) => e.step === "afterWrite")).toHaveLength(1);
        await f.release("afterWrite");
        const decide = () =>
          f.client.send("input.resendUnknown", { threadId, attemptId }, "resend");
        const a = (await decide()).receipt,
          b = (await decide()).receipt;
        expect(a).toEqual(b);
        const next = accepted(a, "inputScheduled");
        expect(next.roundId).toBe(roundId);
        expect(next.messageId).toBe(original.messageId);
        expect(next.attemptId).not.toBe(attemptId);
        expect(next.deliveryId).not.toBe(deliveryId);
        await f.seen("start", next.deliveryId);
        const round = (await f.client.readInputHistory(threadId, roundId)).rounds[0]!;
        expect(round.attempts?.map((a) => [a.attemptId, a.deliveryId, a.origin.kind])).toEqual([
          [attemptId, deliveryId, "initial"],
          [next.attemptId, next.deliveryId, "userResend"],
        ]);
        expect((await f.ledger()).filter((e) => e.step === "afterWrite")).toHaveLength(2);
      },
      ["afterWrite"],
    ),
  20000,
);

test("2 S-STATE-024/051 two reboots hold the original human queue including its automatic follower", async () => {
  for (const mixed of [true, false])
    await withInputPeer(
      async (f) => {
        const a = await f.start();
        if (mixed) {
          const source = heldScenario.environments[0]?.queue?.[1];
          if (source?.source !== "automation" || source.recovery !== "deduplicate")
            throw Error("Missing automatic follower scenario");
          writeFileSync(join(f.stateDir, "auto-row"), "indexer");
          writeFileSync(join(f.stateDir, "dedup"), "");
        }
        const b = await f.send(a.threadId, "B", "second"),
          ids = [a, b];
        if (!mixed) ids.push(await f.send(a.threadId, "C"));
        for (let i = 0; i < 2; i++) {
          await f.restart();
          const h = await f.client.readInputHistory(a.threadId);
          expect(
            h.rounds.map((r) => [r.id, r.messageId, String(r.place), r.attempt.phase]),
          ).toEqual(
            ids.map((r, i) => [
              r.roundId,
              r.messageId,
              String(i + 1),
              { kind: "filed", gate: "held" },
            ]),
          );
          expect(h.messages.map((m) => m.text)).toEqual([
            f.writer.payload.content.text,
            "B",
            ...(!mixed ? ["C"] : []),
          ]);
          expect(await f.ledger()).toEqual([]);
        }
        await f.release("claim");
        expect(
          (await f.client.send("input.releaseQueue", { threadId: a.threadId })).receipt.kind,
        ).toBe("accepted");
        await f.seen("start", a.deliveryId);
        expect(
          (await f.ledger()).filter((e) => e.step === "start").map((e) => e.messageId),
        ).toEqual([a.messageId]);
        expect(
          (await f.client.readInputHistory(a.threadId, b.roundId)).rounds[0]?.attempt.phase,
        ).toEqual({ kind: "filed", gate: "eligible" });
      },
      ["claim", "start"],
    );
}, 30000);
test(
  "3 drop starts the next row and a late native receipt stays with the original delivery",
  () =>
    withInputPeer(
      async (f) => {
        const a = await f.start(),
          b = await f.send(a.threadId);
        const proof = await f.seen("receipt", a.deliveryId);
        await f.restart();
        const payload = { threadId: a.threadId, attemptId: a.attemptId };
        expect((await f.client.send("input.dropUnknown", payload, "drop")).receipt.kind).toBe(
          "accepted",
        );
        await f.release("receipt");
        await f.seen("start", b.deliveryId);
        const before = await f.client.readInputHistory(a.threadId, b.roundId);
        await f.late(b.attemptId, proof);
        await f.release("start");
        await f.seen("lateApplied", a.deliveryId);
        const h = await f.client.readInputHistory(a.threadId, a.roundId);
        const target = h.rounds[0]!;
        expect(
          (await f.client.subscribedRounds(a.threadId)).find((r) => r.id === a.roundId),
        ).toEqual(target);
        const expected = scenarioPhase(dropScenario, "original-receipt-arrives", "round-draft");
        if (expected.kind !== "notDelivered" || !expected.lateReceipt)
          throw Error("Scenario lost the late receipt");
        expect(target.attempt.phase).toMatchObject({
          kind: "notDelivered",
          reason: expected.reason,
          lateReceipt: { sessionId: proof.sessionId, itemId: "native-" + a.deliveryId },
        });
        expect((await f.client.readInputHistory(a.threadId, b.roundId)).rounds).toEqual(
          before.rounds,
        );
      },
      ["receipt", "start", "turn"],
    ),
  20000,
);
test(
  "4 S-STATE-028/043 steer read attaches to its message and its lost receipt replays after completion",
  () =>
    withInputPeer(
      async (f) => {
        const a = await f.start();
        await f.seen("start", a.deliveryId);
        const key = "lost-steer",
          marker = join(f.stateDir, "lose-" + key);
        const payload = {
          threadId: a.threadId,
          attemptId: a.attemptId,
          mode: "insertCurrent",
          content: { ...f.writer.payload.content, text: "steer" },
        };
        writeFileSync(marker, "");
        await expect(f.client.send("input.steer", payload, key)).rejects.toThrow();
        rmSync(marker);
        await f.reconnect();
        const original = f.writer.receipt(key)!;
        const m = accepted(original.receipt, "inputScheduled");
        const read = () => f.client.readInputHistory(a.threadId);
        expect((await read()).rounds[0]?.steering).toEqual([
          { attemptId: a.attemptId, messageId: m.messageId, state: "pending" },
        ]);
        await f.release("steer");
        await f.seen("steerApplied", m.deliveryId);
        expect((await read()).rounds[0]?.steering?.[0]?.state).toBe("completed");
        await f.release("turn");
        await f.seen("ended", a.deliveryId);
        expect(["closing", "finished"]).toContain(
          (await read()).rounds[0]?.attempt.phase.kind ?? "",
        );
        expect((await f.client.send("input.steer", payload, key)).receipt).toEqual(
          original.receipt,
        );
        expect(f.writer.receipt(key)).toEqual(original);
        const result = await read();
        expect(result.rounds).toHaveLength(1);
        expect(result.messages.filter((row) => row.id === m.messageId)).toHaveLength(1);
      },
      ["steer", "turn"],
    ),
  20000,
);
test(
  "5 S-STATE-004 a lost existing-thread send receipt reopens one message and one delivery",
  () =>
    withInputPeer(async (f) => {
      const a = await f.start();
      const key = "ordinary",
        marker = join(f.stateDir, "lose-" + key);
      const payload = { threadId: a.threadId, content: f.writer.payload.content };
      writeFileSync(marker, "");
      await expect(f.client.send("input.send", payload, key)).rejects.toThrow();
      rmSync(marker);
      await f.reconnect();
      const saved = f.writer.receipt(key)!;
      const input = accepted(saved.receipt, "inputScheduled");
      expect((await f.client.send("input.send", payload, key)).receipt).toEqual(saved.receipt);
      await f.seen("start", input.deliveryId);
      expect(f.writer.receipt(key)).toEqual(saved);
      const h = await f.client.readInputHistory(a.threadId, input.roundId);
      expect(h.messages.map((m) => [m.id, m.text])).toEqual([
        [input.messageId, payload.content.text],
      ]);
      expect(h.rounds.map((r) => r.id)).toEqual([input.roundId]);
      expect(h.rounds[0]?.attempts).toHaveLength(1);
      expect(
        (await f.ledger()).filter(
          (e) => e.step === "afterWrite" && e.deliveryId === input.deliveryId,
        ),
      ).toHaveLength(1);
    }),
  20000,
);
