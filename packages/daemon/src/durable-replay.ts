import {
  readThread,
  readRound,
  readMessage,
  runReplayTurn,
  recoverInputDelivery,
  type FirstSendStore,
  type ProviderAdapter,
} from "@kraka/environment";
import type { CommandReceipt, CommandId, ReplayTurnUpdate } from "@kraka/protocol";
export type Started = Extract<
  Extract<CommandReceipt, { kind: "accepted" }>["result"],
  { kind: "threadStarted" }
>;
export async function dispatchReplay<H extends object>(
  store: FirstSendStore,
  result: Started,
  commandId: CommandId,
  replay: { adapter: ProviderAdapter<"replay", H>; expectedText: string; modelId: string },
  update: (value: ReplayTurnUpdate) => void,
  signal: AbortSignal,
) {
  const thread = readThread(store.db, result.threadId),
    message = readMessage(store.db, result.messageId);
  const initial = readRound(store.db, result.roundId);
  if (!thread || !message || !initial) throw new Error("Committed first input missing");
  if (initial.attempt.phase.kind !== "filed" || initial.attempt.phase.gate !== "eligible") return;
  let round = initial;
  const directory = () => {
    const cwd = store.directory(thread);
    if (!cwd) throw new Error("Registered directory unavailable");
    return cwd;
  };
  const phase = (next: typeof round.attempt.phase) => {
    round = store.setPhase(round, next);
  };
  try {
    await runReplayTurn({
      ...replay,
      request: {
        kind: "replay.run",
        commandId,
        permission: "ask",
        input: {
          text: message.text,
          references: message.references,
          attachments: message.attachments,
        },
      },
      workingDirectory: directory(),
      signal,
      persisted: {
        thread,
        round,
        directory,
        phase,
        prepare(delivery) {
          directory();
          store.db.transaction(() => {
            if (store.freeze(delivery) === "conflict") throw new Error("Frozen delivery conflicts");
            phase({ kind: "armed" });
          })();
        },
      },
      emit(value) {
        if (value.kind === "rejected") throw new Error(value.failure.kind);
        if (!("commandId" in value)) update(value);
      },
    });
  } catch (error) {
    const current = round.attempt.phase;
    phase(
      current.kind === "filed"
        ? {
            kind: "notDelivered",
            reason: error instanceof Error ? error.message : "open failed",
            lateReceipt: null,
          }
        : recoverInputDelivery(current, "person", "none"),
    );
  }
}
