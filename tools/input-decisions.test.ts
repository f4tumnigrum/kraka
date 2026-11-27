import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { connectFirstSend } from "./fixtures/first-send-client";
import { withInputPeer } from "./fixtures/input-recovery";

test(
  "two clients can make only one decision for an uncertain head, and retry keeps newer queue edits",
  () =>
    withInputPeer(
      async (f) => {
        const a = await f.start(),
          b = await f.send(a.threadId, "B"),
          c = await f.send(a.threadId, "C");
        await f.seen("beforeWrite", a.deliveryId);
        await f.hold("claim");
        await f.restart();
        const other = await connectFirstSend(f.stateDir, f.writer.instance);
        try {
          const target = { threadId: a.threadId, attemptId: a.attemptId };
          const choices = await Promise.all([
            f.client.send("input.resendUnknown", target, "again"),
            other.send("input.dropUnknown", target, "abandon"),
          ]);
          const won = choices.filter((choice) => choice.receipt.kind === "accepted");
          expect(won).toHaveLength(1);
          expect(choices.filter((r) => r.receipt.kind === "rejected")).toHaveLength(1);
          const winner = won[0]!;
          const h = await f.client.readInputHistory(a.threadId);
          const waiting = h.rounds.filter((r) => r.attempt.phase.kind === "filed");
          const original = waiting.find((r) => r.id === c.roundId)!;
          const edit = await other.send("input.editQueued", {
            threadId: a.threadId,
            roundId: c.roundId,
            baseVersion: original.version,
            content: { ...f.writer.payload.content, text: "edited C" },
          });
          expect(edit.receipt.kind).toBe("accepted");
          expect(
            (await f.client.send(winner.request.method, target, winner.receipt.commandId)).receipt,
          ).toEqual(winner.receipt);
          expect(
            (
              await f.client.send(
                winner.request.method,
                { ...target, attemptId: b.attemptId },
                winner.receipt.commandId,
              )
            ).receipt,
          ).toMatchObject({ failure: { kind: "idConflict" } });
          expect((await f.client.readInputHistory(a.threadId, c.roundId)).messages[0]?.text).toBe(
            "edited C",
          );
        } finally {
          other.close();
        }
      },
      ["beforeWrite"],
    ),
  20000,
);

test(
  "edit racing claim freezes exactly the winning text and reports leftQueue once claimed",
  () =>
    withInputPeer(
      async (f) => {
        const a = await f.start();
        const edit = () =>
          f.client.send("input.editQueued", {
            threadId: a.threadId,
            roundId: a.roundId,
            baseVersion: "1",
            content: f.writer.payload.content,
          });
        const changing = edit();
        await f.release("claim");
        const result = await changing;
        await f.seen("beforeWrite", a.deliveryId);
        expect((await edit()).receipt).toMatchObject({
          failure: { kind: "queueConflict", reason: "leftQueue" },
        });
        const h = await f.client.readInputHistory(a.threadId);
        expect(String(h.messages[0]?.version)).toBe(result.receipt.kind === "accepted" ? "2" : "1");
        expect((await f.ledger())[0]?.data).toMatchObject({
          id: a.messageId,
          text: h.messages[0]?.text,
        });
      },
      ["claim", "beforeWrite"],
    ),
  20000,
);

test(
  "same-delivery retry sends the original frozen handoff after the parent changes",
  () =>
    withInputPeer(
      async (f) => {
        writeFileSync(join(f.stateDir, "dedup"), "");
        const a = await f.start();
        const handoff = {
          transferId: "handoff-A",
          source: {
            environmentId: f.writer.instance.environmentId,
            threadId: a.threadId,
            roundId: a.roundId,
          },
          messageIds: [a.messageId, "old-message"],
          history: {
            coverage: "partial",
            missingSources: [
              {
                kind: "missingThread",
                environmentId: f.writer.instance.environmentId,
                threadId: "parent",
              },
            ],
            omittedItems: 3,
          },
        };
        writeFileSync(
          join(f.stateDir, "seed-handoff"),
          JSON.stringify({ roundId: a.roundId, handoff }),
        );
        await f.release("claim");
        await f.seen("afterWrite", a.deliveryId);
        await f.restart();
        const h = await f.client.readInputHistory(a.threadId);
        expect(h.rounds[0]?.attempt.phase).toMatchObject({
          kind: "recovering",
          gate: "held",
          action: "retrySameDelivery",
        });
        await f.client.send("thread.rename", { threadId: a.threadId, title: "changed parent" });
        await f.send(a.threadId, "new message after the write");
        await f.release("afterWrite");
        expect(
          (await f.client.send("input.releaseQueue", { threadId: a.threadId })).receipt.kind,
        ).toBe("accepted");
        await f.seen("start", a.deliveryId);
        const delivery = (await f.ledger()).filter((row) => row.deliveryId === a.deliveryId);
        expect(delivery.filter((row) => row.step === "externalEffect")).toHaveLength(1);
        expect(delivery.filter((row) => row.step === "afterWrite")).toHaveLength(2);
        const handoffs = delivery.filter((row) => row.step === "handoff");
        expect(handoffs.map((row) => row.attemptId)).toEqual([a.attemptId, a.attemptId]);
        expect(handoffs[0]?.data).toEqual({ kind: "handoff", ...handoff });
        expect(JSON.stringify(handoffs[1]?.data)).toBe(JSON.stringify(handoffs[0]?.data));
      },
      ["claim", "afterWrite"],
    ),
  20000,
);
