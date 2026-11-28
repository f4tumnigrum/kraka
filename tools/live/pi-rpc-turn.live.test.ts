// Live cases 4; required groups ["1.", "2.", "3.", "4."]
// Live junit pi-rpc-turn.xml
import { beforeAll, afterAll, expect, test } from "bun:test";
import { mkdtemp, rm, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accepted } from "../fixtures/first-send";
import { hostRelease } from "../fixtures/installed";
import { buildPiPeer } from "../fixtures/pi-rpc";
import { withInstalledPi } from "../fixtures/pi-installed";
let dir: string, peer: string, archive: Awaited<ReturnType<typeof hostRelease>>;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kraka-pi-installed-"));
  [peer, archive] = await Promise.all([buildPiPeer(dir), hostRelease(dir)]);
}, 120_000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
test("1. Select the executable and policy", async () => {
  await withInstalledPi(archive, peer, [], async (f) => {
    expect(f.refreshed).toMatchObject({
      instanceId: f.registration.instanceId,
      binaryVersion: "1.6.0",
      compatibilityAdvisory: null,
      readiness: {
        installed: { state: "yes", verifiedAt: expect.any(Number) },
        authenticated: { state: "yes", verifiedAt: expect.any(Number) },
      },
      snapshot: { family: "pi", permission: f.registration.permission },
    });
    const start = await f.start("questions"),
      first = await f.connect(start.threadId);
    const todo = await first.question("question-1");
    const root = first.rounds().find((r) => r.id === start.roundId)?.attempt.phase;
    expect(root).toMatchObject({
      kind: "working",
      root: {
        id: `weak:pi:1:${start.attemptId}`,
        sessionId: expect.any(String),
        toolPolicy: {
          selectedMode: "ask",
          effectiveMode: "ask",
          supportedModes: ["ask", "edits"],
          enforcement: "adapter",
        },
      },
    });
    await first.close();
    const reconnected = await f.connect(start.threadId);
    const restored = await reconnected.question("question-1");
    expect(restored.id).toBe(todo.id);
    accepted(await reconnected.answer(todo.id, "question-1", "jade"), "todoAnswerStored");
    await reconnected.question("question-2");
    const saved = accepted(
      await reconnected.client.rpc("todo.readAnswer", {
        threadId: start.threadId,
        todoRequestId: todo.id,
      }),
      "todoAnswerRead",
    );
    expect(saved).toMatchObject({
      authorId: f.principal.id,
      deviceId: f.device,
      content: { answers: [{ questionKey: "question-1", answer: "jade" }] },
    });
    const rows = await f.rows();
    expect(rows.filter((r) => r.event === "launch")).toContainEqual(
      expect.objectContaining({
        args: expect.arrayContaining([
          "--mode",
          "rpc",
          "--session-dir",
          f.registration.driver.historyRoot,
          "--extension",
        ]),
        cwd: await realpath(f.site.cwd),
        account: f.registration.driver.configurationRoot,
      }),
    );
    expect(
      rows.map((r) => r.frame).filter((frame) => frame?.type === "extension_ui_response"),
    ).toEqual([{ type: "extension_ui_response", id: "question-1", value: "jade" }]);
    expect(await f.checkIdentity()).toBe(f.project.environmentId);
  });
}, 60_000);
test("2. The active RPC child exits", async () => {
  await withInstalledPi(archive, peer, [], async (f) => {
    const start = await f.start("questions"),
      r = await f.connect(start.threadId);
    const first = await r.question("question-1");
    accepted(await r.answer(first.id, "question-1", "jade"), "todoAnswerStored");
    const second = await r.question("question-2"),
      old = await f.wait("agentStarted", 1);
    process.kill(old.pid, "SIGKILL");
    const phase = () =>
      r.rounds().find((v) => v.id === start.roundId && v.attempt.attemptId === start.attemptId)
        ?.attempt.phase;
    await r.until(() => phase()?.kind === "interrupted", "Pi child exit evidence");
    const interrupted = phase();
    if (interrupted?.kind !== "interrupted" || interrupted.failure.kind !== "unexpectedExit")
      throw Error("Missing native Pi exit");
    expect(
      interrupted.failure.signal !== null ||
        (interrupted.failure.code !== null && interrupted.failure.code !== 0),
    ).toBe(true);
    const cached = await r.answer(second.id, "question-2", "late");
    expect(cached).toMatchObject({
      kind: "rejected",
      failure: { kind: "todoChanged", current: { id: second.id, state: { kind: "expired" } } },
    });
    const again = await r.send("retry");
    await r.until(
      () => r.rounds().some((x) => x.id === again.roundId && x.attempt.phase.kind === "finished"),
      "reopened Pi round",
    );
    const rows = await f.rows();
    expect(rows).toContainEqual(
      expect.objectContaining({
        event: "launch",
        args: expect.arrayContaining(["--session", interrupted.root.sessionId]),
      }),
    );
    expect(rows.filter((s) => s.epoch === 2 && s.frame?.type === "extension_ui_response")).toEqual(
      [],
    );
    expect(await f.checkIdentity()).toBe(f.project.environmentId);
  });
}, 60_000);
test("3. A pipe can fail before exit is known", async () => {
  await withInstalledPi(archive, peer, ["beforePipeClose", "pipeClosed"], async (f) => {
    const start = await f.start("pipe"),
      r = await f.connect(start.threadId);
    await f.wait("beforePipeClose", 1);
    await r.until(
      () => r.rounds().some((x) => x.attempt.phase.kind === "working"),
      "observed native root",
    );
    f.release("beforePipeClose");
    const child = await f.wait("pipeClosed", 1);
    const phase = () =>
      r.rounds().find((x) => x.attempt.attemptId === start.attemptId)?.attempt.phase;
    await r.until(() => phase()?.kind === "interrupted", "transport error on open process");
    const original = phase();
    expect(original).toMatchObject({ kind: "interrupted", failure: { kind: "transportError" } });
    expect(() => process.kill(child.pid, 0)).not.toThrow();
    f.release("pipeClosed");
    const next = await r.send("handled");
    await r.until(
      () => r.rounds().some((x) => x.id === next.roundId && x.attempt.phase.kind === "handled"),
      "new input handled",
    );
    const reread = await f.connect(start.threadId);
    expect(reread.rounds().find((row) => row.id === start.roundId)).toMatchObject({
      attempt: { phase: original },
    });
    expect(
      (await f.rows()).some((row) => row.pid === child.pid && row.event === "pipeClosed"),
    ).toBe(true);
  });
}, 60_000);
test("4. An unassigned Pi item stays in history", async () => {
  await withInstalledPi(
    archive,
    peer,
    ["beforeHistoryLink", "historyRead", "historyReplay2", "historyReplay3"],
    async (f) => {
      const start = await f.start("observe"),
        r = await f.connect(start.threadId);
      const items = () =>
        r
          .rows()
          .flatMap((v) =>
            v.objectType === "timelineItem" &&
            v.value.kind === "executorObservation" &&
            v.value.source.sourceId === "call-7"
              ? [v.value]
              : [],
          );
      await r.until(() => items().length === 1, "unassigned Pi observation");
      const [original] = items();
      if (!original) throw Error("Missing Pi observation");
      expect(original).toMatchObject({
        version: "1",
        assignment: { kind: "session" },
        source: { sourceId: "call-7", epoch: 1 },
      });
      expect(r.todos()).toHaveLength(0);
      expect(r.rounds()).toHaveLength(1);
      const fresh = await f.connect(start.threadId);
      expect(fresh.rows()).toContainEqual({ objectType: "timelineItem", value: original });
      await fresh.close();
      f.release("beforeHistoryLink");
      await f.wait("historyRead", 1);
      expect(items()).toEqual([original]);
      f.release("historyRead");
      await r.until(() => items()[0]?.version === "2", "linked observation");
      const linked = {
        ...original,
        version: "2",
        assignment: {
          kind: "attempt",
          attemptId: start.attemptId,
          relationship: { kind: "item", nativeItemId: "assistant-native-8" },
        },
      };
      expect(items()).toMatchObject([linked]);
      await f.wait("historyReplay2", 1);
      f.release("historyReplay2");
      await f.wait("historyReplay3", 1);
      f.release("historyReplay3");
      await r.until(
        () =>
          r
            .rows()
            .some(
              (x) =>
                x.objectType === "timelineItem" && x.value.source.sourceId === "proofs-drained",
            ),
        "duplicate and conflicting history proofs drained",
      );
      expect(items()).toMatchObject([linked]);
      const stop = await r.client.rpc("round.stop", {
        threadId: start.threadId,
        attemptId: start.attemptId,
      });
      expect(stop.kind).toBe("accepted");
      await r.until(
        () =>
          r.rounds().some((x) => x.id === start.roundId && x.attempt.phase.kind === "endedEarly"),
        "settled first attempt",
      );
      expect(
        (await r.history()).rows.filter(
          (x) => x.objectType === "timelineItem" && x.value.id === original.id,
        ),
      ).toMatchObject([{ value: linked }]);
      const other = await r.send("observe");
      await r.until(
        () =>
          items().some(
            (x) =>
              x.source.epoch === 2 &&
              x.assignment.kind === "attempt" &&
              x.assignment.attemptId === other.attemptId,
          ),
        "independent new epoch",
      );

      expect(
        (await r.history()).rows.filter(
          (x) => x.objectType === "timelineItem" && x.value.id === original.id,
        ),
      ).toMatchObject([{ value: linked }]);
    },
  );
}, 60_000);
