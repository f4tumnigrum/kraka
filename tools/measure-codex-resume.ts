import { runCodexCase } from "./fixtures/codex-resume";
import type { ReportBase } from "./perf";
import { readRound, openReceiptReader } from "@kraka/environment";
export async function measureCodexResume(
  base: ReportBase,
  root: string,
  nextBlock: () => Promise<void>,
) {
  base.expected = { recoveries: 5, attempts: 5, requests: 5 };
  const actual = { recoveries: 0, attempts: 0, requests: 0 };
  base.actual = actual;
  for (let i = 0; i < 5; i++) {
    await runCodexCase(
      "ask",
      async (s) => {
        const original = await s.start("command"),
          a = await s.replica(original.threadId);
        s.action(original.turn.handle, "callback");
        await s.event("callback-opened");
        const request = await a.todos.until((r) => r.state.kind === "open");
        s.action(original.turn.handle, "hide-end");
        await s.event("root-ended");
        await a.close();
        const start = await s.restart(true),
          b = await s.replica(original.threadId);
        const restored = await b.todos.until(
          (r) => r.id === request.id && r.state.kind === "expired",
        );
        await b.rounds.until(
          (r) => r.id === original.roundId && r.attempt.phase.kind === "closing",
        );
        const db = openReceiptReader(s.state);
        try {
          const phase = (await s.client.readInputHistory(original.threadId, original.roundId))
            .rounds[0]?.attempt;
          const round = readRound(db, original.roundId);
          if (
            phase?.attemptId !== original.attemptId ||
            phase.phase.kind !== "closing" ||
            phase.phase.endedAt !== 1767225603000 ||
            round?.attempt.attemptId !== original.attemptId ||
            restored.roundId !== round.id
          )
            throw Error("Wrong recovered Codex request or attempt disposition");
          const value = performance.now() - start;
          actual.recoveries++;
          actual.attempts++;
          actual.requests++;
          base.samples.push({ series: "codexRecovery", unit: "ms", value });
          base.observations.push({
            threadId: original.threadId,
            roundId: original.roundId,
            attemptId: original.attemptId,
            requestId: request.id,
            attempt: phase.phase.kind,
            request: restored.state.kind,
            elapsedMs: value,
          });
        } finally {
          db.close(true);
        }
      },
      root,
    );
    await nextBlock();
  }
  return { codexRecovery: 5 };
}
