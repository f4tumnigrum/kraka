// Live cases 4; required groups ["1.", "2.", "3.", "4."]
import { finishedCapture } from "../fixtures/first-send-client";
import { test, expect } from "bun:test";
import { readRound, openReceiptReader } from "@kraka/environment";
import { runCodexCase as run } from "../fixtures/codex-resume";
import { accepted } from "../fixtures/first-send";
const decide = (choiceKey: string) => ({
  kind: "approval",
  choiceKey,
  scope: "once",
  decision: choiceKey === "accept" ? "allow" : "deny",
});
test("1. J-1.6 signed choices reach their original command, file or question callback", async () => {
  for (const [kind, reply, mode] of [
    ["command", "accept", "ask"],
    ["command", "decline", "ask"],
    ["file", "decline", "edits"],
    ["file", "accept", "edits"],
    ["question", "blue", "open"],
  ] as const) {
    await run(mode, async (s) => {
      const first = await s.start(kind),
        device = await s.replica(first.threadId);
      s.action(first.turn.handle, "callback");
      const opened = await s.event("callback-opened");
      const todo = await device.todos.until((t) => t.state.kind === "open");
      expect(todo.state).toMatchObject({
        route: { kind: "live", subject: kind === "question" ? "question" : "approval" },
      });
      const ids = { threadId: first.threadId, todoRequestId: todo.id };
      if (kind === "file") {
        expect(todo.body).toMatchObject({
          tool: "file",
          choices: [{ key: "accept" }, { key: "decline" }],
        });
        expect(
          (
            await device.rpc("todo.decide", {
              ...ids,
              decision: { ...decide("acceptForSession"), scope: "session" },
            })
          ).kind,
        ).toBe("rejected");
      }
      const result =
        kind === "question"
          ? await device.rpc("todo.answer", {
              ...ids,
              answers: [{ questionKey: "color", answer: reply }],
            })
          : await device.rpc("todo.decide", { ...ids, decision: decide(reply) });
      accepted(result, "todoAnswerStored");
      const wire = await s.event("reply-written");
      expect(wire).toMatchObject({
        id: kind === "file" ? "4001" : 4001,
        handle: opened.handle,
        epoch: 1,
        result:
          kind === "question" ? { answers: { color: { answers: [reply] } } } : { decision: reply },
      });
      const record = accepted(await device.rpc("todo.readAnswer", ids), "todoAnswerRead");
      expect(record.content).toMatchObject(
        kind === "question"
          ? { answers: [{ questionKey: "color", answer: reply }] }
          : decide(reply),
      );
      const answered = await device.todos.until(
        (t) => t.id === todo.id && t.state.kind === "answered",
      );
      expect(answered.state).not.toMatchObject({ arrival: { kind: "received" } });
      s.action(wire.handle, "finish");
      if (reply === "decline")
        expect(await s.updates.until((e) => e.kind === "executor.failed")).toMatchObject({
          reason: "operationRejected",
          message: "User declined the requested action",
        });
      else
        expect(await s.updates.until((e) => e.kind === "assistant.final")).toMatchObject({
          text: "The marker was coral.",
        });
      await s.updates.until((e) => e.kind === "round.ended");
    });
  }
  await run("ask", async (s) => {
    const r = await s.start("secret"),
      d = await s.replica(r.threadId);
    s.action(r.turn.handle, "callback");
    await s.event("callback-opened");
    const secret = await d.todos.until((t) => t.body.kind === "secret");
    expect(
      (
        await d.rpc("todo.answer", {
          threadId: r.threadId,
          todoRequestId: secret.id,
          answers: [{ questionKey: "color", answer: "synthetic" }],
        })
      ).kind,
    ).toBe("rejected");
    expect(s.events.items.filter((e) => e.event === "reply-written")).toHaveLength(0);
  });
}, 90000);
test("2. S-STATE-017 natural completion wins an interrupt while the public attempt looks running", async () => {
  await run("ask", async (s) => {
    const first = await s.start("interrupt"),
      p = { threadId: first.threadId, attemptId: first.attemptId };
    s.action(first.turn.handle, "hide-end");
    await s.event("root-ended");
    const stop = await s.client.send("round.stop", p, "stop-original");
    accepted(stop.receipt, "actionAccepted");
    const hit = await s.event("interrupt-received");
    expect(hit.root).toBe(first.turn.root);
    const payload = { threadId: first.threadId, stopCommandId: "stop-original" };
    expect(
      accepted((await s.client.send("round.readStop", payload)).receipt, "stopResult"),
    ).toMatchObject({
      disposition: "pending",
      reachedAt: null,
    });
    s.action(hit.handle, "publish-before-interrupt-reply");
    const ended = await s.updates.until((e) => e.kind === "round.ended");
    expect(ended).toMatchObject({
      outcome: "completed",
      endedAt: 1767225603000,
      endTimeEvidence: {
        source: "executorReported",
        executorEndedAt: 1767225603000,
        environmentObservedAt: expect.any(Number),
      },
    });
    expect(await s.event("interrupt-replied")).toMatchObject({
      handle: hit.handle,
      id: hit.id,
      root: hit.root,
    });
    const before = await s.acknowledgedStop(first.threadId, payload.stopCommandId);
    expect(before).toMatchObject({
      disposition: "alreadyEnded",
      roundId: first.roundId,
      attemptId: first.attemptId,
      rootId: hit.root,
      epoch: 1,
      timedOutAt: null,
      reachedAt: expect.any(Number),
    });
    const captureId = await finishedCapture(s.client, first);
    await s.restart();
    expect(
      accepted((await s.client.send("round.readStop", payload)).receipt, "stopResult"),
    ).toEqual(before);
    const db = openReceiptReader(s.state);
    try {
      expect(readRound(db, first.roundId)?.attempt.phase).toMatchObject({
        kind: "finished",
        captureId,
        endTimeEvidence: "endTimeEvidence" in ended ? ended.endTimeEvidence : null,
      });
    } finally {
      db.close(true);
    }
  });
  await run("ask", async (s) => {
    const r = await s.start("interrupt");
    accepted(
      (
        await s.client.send(
          "round.stop",
          { threadId: r.threadId, attemptId: r.attemptId },
          "stop-native",
        )
      ).receipt,
      "actionAccepted",
    );
    const interrupt = await s.event("interrupt-received");
    s.action(interrupt.handle, "interrupt-reply");
    const pending = await s.acknowledgedStop(r.threadId, "stop-native");
    expect(pending).toMatchObject({
      disposition: "pending",
      attemptId: r.attemptId,
      rootId: interrupt.root,
    });
    s.action(interrupt.handle, "stop");
    expect(await s.updates.until((e) => e.kind === "round.ended")).toMatchObject({
      outcome: "stopped",
    });
    expect(
      accepted(
        (
          await s.client.send("round.readStop", {
            threadId: r.threadId,
            stopCommandId: "stop-native",
          })
        ).receipt,
        "stopResult",
      ),
    ).toMatchObject({ disposition: "stopped", reachedAt: pending.reachedAt, timedOutAt: null });
  });
  await run("ask", async (s) => {
    const r = await s.start("unavailable");
    s.action(r.turn.handle, "finish");
    await s.updates.until((e) => e.kind === "round.ended");
    const captureId = await finishedCapture(s.client, r);
    await s.restart();
    expect((await s.input(r.threadId, "retry")).receipt).toMatchObject({
      kind: "rejected",
      failure: { kind: "invalidState" },
    });
    expect(
      (await s.client.readInputHistory(r.threadId, r.roundId)).rounds[0]?.attempt,
    ).toMatchObject({ attemptId: r.attemptId, phase: { kind: "finished", captureId } });
    expect(s.events.items.filter((e) => e.event === "turn")).toHaveLength(1);
  });
}, 45000);
test(
  "3. S-STATE-036 / S-EXEC-024 a cached approval cannot write to reused native ID 4001",
  () =>
    run("ask", async (s) => {
      const first = await s.start("command"),
        a = await s.replica(first.threadId);
      s.action(first.turn.handle, "callback");
      await s.event("callback-opened");
      const old = await a.todos.until((t) => t.state.kind === "open");
      s.action(first.turn.handle, "hide-end");
      await s.event("root-ended");
      await a.close();
      await s.restart(true);
      const b = await s.replica(first.threadId);
      expect((await b.todos.until((t) => t.id === old.id)).state).toMatchObject({
        kind: "expired",
        reason: expect.stringContaining("not resumable"),
      });
      const since = s.events.items.length;
      accepted((await s.input(first.threadId, "command")).receipt, "inputScheduled");
      const next = await s.event("turn", since);
      expect(next.session).toBe(first.turn.session);
      expect(next.epoch).toBeGreaterThan(1);
      expect(next.handle).not.toBe(first.turn.handle);
      s.action(next.handle, "callback");
      const reused = await s.event("callback-opened", since);
      expect(reused.id).toBe(4001);
      const fresh = await b.todos.until((t) => t.id !== old.id && t.state.kind === "open");
      expect(
        (
          await b.rpc("todo.decide", {
            threadId: first.threadId,
            todoRequestId: old.id,
            decision: decide("accept"),
          })
        ).kind,
      ).toBe("rejected");
      expect(s.events.items.filter((e) => e.event === "reply-written")).toHaveLength(0);
      accepted(
        await b.rpc("todo.decide", {
          threadId: first.threadId,
          todoRequestId: fresh.id,
          decision: decide("decline"),
        }),
        "todoAnswerStored",
      );
      expect(await s.event("reply-written", since)).toMatchObject({
        handle: next.handle,
        id: 4001,
        result: { decision: "decline" },
      });
      expect(
        s.events.items.filter((e) => e.event === "reply-written" && e.handle === first.turn.handle),
      ).toHaveLength(0);
      s.action(next.handle, "finish");
      await s.event("root-ended", since);
    }),
  40000,
);
test(
  "4. S-STATE-037 one linked message survives loss; steers and queued inputs stay distinct",
  () =>
    run("ask", async (s) => {
      const first = await s.start("question"),
        a = await s.replica(first.threadId);
      s.action(first.turn.handle, "callback");
      await s.event("callback-opened");
      const original = await a.todos.until((t) => t.state.kind === "open");
      s.action(first.turn.handle, "hide-end");
      await s.event("root-ended");
      await a.close();
      await s.restart(true);
      const b = await s.replica(first.threadId);
      const restored = await b.todos.until((t) => t.id === original.id);
      expect(restored.state).toMatchObject({
        kind: "open",
        route: { kind: "message", nodeId: "node-original" },
      });
      const since = s.events.items.length;
      accepted(
        await b.rpc("todo.answer", {
          threadId: first.threadId,
          todoRequestId: original.id,
          answers: [{ questionKey: "color", answer: "blue" }],
        }),
        "todoAnswerStored",
      );
      const linked = await s.event("turn", since);
      expect(linked).toMatchObject({ text: "blue", session: first.turn.session });
      expect(linked.epoch).toBeGreaterThan(first.turn.epoch);
      const answered = await b.todos.until(
        (t) => t.id === original.id && t.state.kind === "answered",
      );
      expect(answered.state).toMatchObject({ arrival: { kind: "viaMessage" } });
      if (answered.state.kind !== "answered" || answered.state.answer.content.kind !== "message")
        throw Error("Missing fallback link");
      const messageId = answered.state.answer.content.messageId;
      const answerRound = await b.rounds.until(
        (r) => r.messageId === messageId && r.attempt.phase.kind === "working",
      );
      expect(answerRound.attempt.attemptId).toBe(answered.state.answer.attemptId);
      s.action(linked.handle, "finish");
      await s.event("root-ended", since);
      const input = accepted((await s.input(first.threadId, "steer")).receipt, "inputScheduled"),
        running = await s.events.untilDispatch((e) => e.event === "turn" && e.text === "steer");
      await s.updates.untilDispatch(
        (e) => e.kind === "round.started" && e.attemptId === input.attemptId,
      );
      for (const [mode, text] of [
        ["queueNext", "resume"],
        ["insertCurrent", "add detail"],
      ] as const)
        accepted(
          (
            await s.client.send("input.steer", {
              threadId: first.threadId,
              attemptId: input.attemptId,
              mode,
              content: { text, attachments: [], references: [] },
            })
          ).receipt,
          "inputScheduled",
        );
      expect(await s.event("steered")).toMatchObject({
        root: running.root,
        input: [{ text: "add detail" }],
      });
      expect(
        (
          await b.rounds.until(
            (r) =>
              r.id === input.roundId &&
              r.steering?.some((m) => m.submission === "submitted") === true,
          )
        ).steering,
      ).toMatchObject([{ state: "pending", submission: "submitted" }]);
      expect(s.events.items.some((e) => e.text === "resume")).toBe(false);
      s.action(running.handle, "finish");
      const queued = await s.events.untilDispatch((e) => e.event === "turn" && e.text === "resume");
      expect(queued).toMatchObject({ session: linked.session });
      s.action(queued.handle, "finish");
      expect(s.events.items.filter((e) => e.event === "turn" && e.text === "blue")).toHaveLength(1);
      expect(s.events.items.filter((e) => e.event === "reply-written")).toHaveLength(0);
    }),
  40000,
);
