import { openAccessHost } from "./access";
import {
  threadConnection,
  type FixtureThreadCommand,
  type FixtureSettingReply,
} from "./thread-connection";
import { CodexInstances } from "./codex-instances";
import {
  bindingContext,
  dispatchCodex,
  reconcileCodex,
  resumeBinding,
  type PreparedSession,
} from "./durable-codex";
import {
  acceptFirstInput,
  OrdinaryStops,
  savedBinding,
  recordCommand,
  prepareClaim,
  restoreForInput,
  readManaged,
  selectionSweepMs,
  type Managed,
  type LocalActor,
  type PreparationHook,
  applyInputCommand,
  advanceQueue,
  type FirstSendStore,
  firstPending,
  loadQueue,
  type ProviderAdapter,
  type RecoveryScope,
  readMessage,
  readReceipt,
  readRound,
  readThread,
  GitStatusCache,
} from "@kraka/environment";
import {
  type CommandId,
  CommandIdSchema,
  AttemptIdSchema,
  type CommandReceipt,
  REQUEST_METHODS,
  type ReplayTurnUpdate,
  type Round,
  type RoundId,
  type ExecutorTurnUpdate,
  RoundSchema,
  type SignedRequest,
  type ThreadId,
} from "@kraka/protocol";
import * as v from "valibot";
import { type ActiveSteers, dispatchReplay, inspectOriginalInput } from "./durable-replay";
export type ReplayWriter<H extends object> = {
  adapter: ProviderAdapter<"replay", H>;
  expectedText: string;
  modelId: string;
  recovery?: RecoveryScope;
  confirmFencedAbsence?: (id: import("@kraka/protocol").DeliveryId) => Promise<boolean>;
} | null;
export type WriterLifecycle = {
  queueChanged?: (threadId: ThreadId) => void;
  preparation?: PreparationHook;
  observeFrame?: (epoch: string, wire: import("@kraka/protocol").WireMessage) => void;
  inspectPage?: (
    page: import("@kraka/protocol").SubscriptionPage,
  ) => import("@kraka/protocol").SubscriptionPage;
  threadCommand?: FixtureThreadCommand;
  beforeInputReceipt?: (
    request: SignedRequest,
    receipt: CommandReceipt,
    deliver: () => void,
  ) => void;
  beforeTodo?: (id: CommandId, proceed: () => void) => void;
  settingReply?: FixtureSettingReply;
  beforeDispatch?: (thread: ThreadId) => Promise<void>;
  locked?: () => void;
  capture?: import("@kraka/environment").CaptureHook;
  opened?: (store: FirstSendStore) => void;
  committed?: (request: SignedRequest, receipt: CommandReceipt) => void | "disconnect";
  update?: (event: ReplayTurnUpdate) => void;
  browserFixture?: (path: string) => Response | null;
  gitProcess?: (directory: string, granularity: "branch" | "detailed") => void;
};
export function threadWork<H extends object>(
  transaction: FirstSendStore,
  authHost: Awaited<ReturnType<typeof openAccessHost>>,
  actor: Pick<LocalActor, "id">,
  codex: CodexInstances,
  replay: ReplayWriter<H>,
  lifecycle?: WriterLifecycle,
) {
  const stops = new OrdinaryStops(transaction);
  const gitStatusCache = new GitStatusCache(Date.now, lifecycle?.gitProcess);
  const turns = new Map<string, Promise<void>>();
  const controller = new AbortController();
  transaction.captures.signal = controller.signal;
  const sweep = () =>
    transaction.db.run("DELETE FROM worktree_selections WHERE expires<=?", [Date.now()]);
  sweep();
  const preparing = new Map<string, Promise<void>>();
  function resume(m: Managed, retry = false) {
    const id = m.claim.worktreeId;
    const pending = preparing.get(id);
    if (pending) return pending;
    const run = Bun.sleep(0)
      .then(() => prepareClaim({ claim: m, transaction, hook: lifecycle?.preparation, retry }))
      .then(() => {
        if (accepting) schedule(m.claim.threadId, m.firstCommand);
      })
      .finally(() => preparing.delete(id));
    preparing.set(id, run);
    return run;
  }
  const recovering = new Map<ThreadId, Promise<boolean>>();
  function recoverRoot(threadId: ThreadId, roundId: RoundId) {
    const active = recovering.get(threadId);
    if (active) return active;
    const recover = async () => {
      const reg = codex.forThread(threadId),
        thread = readThread(transaction.db, threadId);
      if (!thread || !reg) return false;
      const selection = await codex.resolve(reg, actor.id, thread),
        round = readRound(transaction.db, roundId);
      return (
        !!(selection && round && accepting) &&
        reconcileCodex(
          transaction,
          round,
          selection,
          () =>
            accepting &&
            codex.current(selection.reg.instanceId, actor.id, selection.cwd)?.snapshot ===
              selection.snapshot &&
            transaction.directory(thread) === selection.cwd,
          stops,
        )
      );
    };
    const work = recover().finally(() => recovering.delete(threadId));
    recovering.set(threadId, work);
    return work;
  }
  const prepared = new Map<RoundId, PreparedSession>();
  function discardPrepared(roundId: RoundId) {
    const session = prepared.get(roundId);
    prepared.delete(roundId);
    if (session?.opened.kind === "ok") {
      const closing = session.adapter.close(session.opened.value, "restart");
      codex.active.add(closing);
      void closing.finally(() => codex.active.delete(closing)).catch(() => {});
    }
  }
  transaction.onQueueChanged = (threadId) =>
    queueMicrotask(() => {
      lifecycle?.queueChanged?.(threadId);
      for (const [roundId, session] of prepared) {
        const round = readRound(transaction.db, roundId);
        if (
          round?.threadId === threadId &&
          (round.attempt.phase.kind !== "filed" ||
            round.attempt.phase.gate !== "eligible" ||
            session.opened.kind !== "ok" ||
            session.opened.value.handle.attemptId !== round.attempt.attemptId)
        )
          discardPrepared(roundId);
      }
    });
  const opening = new Map<ThreadId, Promise<CommandReceipt>>();
  function sendInput(
    sender: LocalActor,
    command: Extract<SignedRequest, { method: "input.send" }>,
  ) {
    const threadId = command.payload.threadId;
    if (!codex.forThread(threadId)) return fileInput(sender, command);
    const work = (opening.get(threadId) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        const target = { kind: "thread" as const, threadId },
          ctx = { actor: sender, commandId: command.commandId, transaction };
        let prior = savedBinding(transaction, threadId);
        const thread = readThread(transaction.db, threadId),
          reg = codex.forThread(threadId);
        if (
          !prior ||
          !thread ||
          !reg ||
          !sender.allows("thread.send", target) ||
          readReceipt(transaction.db, sender.id, command.commandId)
        )
          return fileInput(sender, command);
        const refuse = () =>
          recordCommand(ctx, REQUEST_METHODS.sendInput, command.payload, target, () => ({
            kind: "rejected",
            commandId: command.commandId,
            failure: { kind: "invalidState" },
          }));
        let queue = loadQueue(transaction, threadId, true);
        const head = firstPending(queue.rows);
        if (head?.attempt.phase.kind === "unobserved") {
          if (!(await recoverRoot(threadId, head.id))) return refuse();
          prior = savedBinding(transaction, threadId);
          if (!prior) return refuse();
          queue = loadQueue(transaction, threadId, true);
        }
        if (
          queue.rows.some((r) => r.attempt.phase.kind !== "closing") ||
          !transaction.directory(thread)
        )
          return fileInput(sender, command);
        const s = await codex.resolve(reg, actor.id, thread);
        if (!accepting || !s || bindingContext(s) !== prior.context) return refuse();
        const attempt = v.parse(AttemptIdSchema, crypto.randomUUID());
        const candidate = await resumeBinding(s, prior.nativeSessionId, prior.epoch, attempt);
        if (candidate.opened.kind === "rejected") return refuse();
        let retained = false;
        try {
          if (
            !accepting ||
            transaction.directory(thread) !== s.cwd ||
            !Bun.deepEquals(savedBinding(transaction, threadId), prior) ||
            codex.current(s.reg.instanceId, actor.id, s.cwd)?.snapshot !== s.snapshot
          )
            return refuse();
          const receipt = await fileInput(sender, command, attempt);
          if (
            receipt.kind === "accepted" &&
            receipt.result.kind === "inputScheduled" &&
            receipt.result.attemptId === attempt
          ) {
            prepared.set(receipt.result.roundId, candidate);
            retained = true;
          }
          return receipt;
        } finally {
          if (!retained) await candidate.adapter.close(candidate.opened.value, "restart");
        }
      });
    opening.set(threadId, work);
    void work
      .finally(() => {
        if (opening.get(threadId) === work) opening.delete(threadId);
      })
      .catch(() => {});
    return work;
  }
  const fileInput = (
    actor: LocalActor,
    command: Extract<SignedRequest, { method: "input.send" }>,
    preparedAttempt?: import("@kraka/protocol").AttemptId,
  ) =>
    restoreForInput(
      { actor, transaction, commandId: command.commandId },
      command.payload,
      (m) => resume(m),
      () =>
        applyInputCommand({
          actor,
          transaction,
          command,
          ...(preparedAttempt ? { preparedAttempt } : {}),
        }),
    );
  let accepting = true;
  const steers: ActiveSteers = new Map();
  function steerInput(actor: LocalActor, cmd: Extract<SignedRequest, { method: "input.steer" }>) {
    const prior = readReceipt(transaction.db, actor.id, cmd.commandId);
    const receipt = applyInputCommand({
      actor,
      transaction,
      command: cmd,
      supportsSteer: (id) => steers.has(id),
    });
    if (!prior && receipt.kind === "accepted" && receipt.result.kind === "inputScheduled") {
      const r = receipt.result;
      if (cmd.payload.mode === "insertCurrent") {
        const input = readMessage(transaction.db, r.messageId);
        if (input)
          void steers
            .get(r.attemptId)?.(input, r.deliveryId)
            .catch(() => {});
      } else schedule(cmd.payload.threadId, cmd.commandId);
    }
    return receipt;
  }
  const inspections = new Map<ThreadId, Round[]>();
  let startupRecoveryPending = true;
  const recipients = new Map<
    RoundId,
    { readonly readyState: number; send(data: string): number }
  >();
  function schedule(threadId: ThreadId, commandId: CommandId) {
    if (turns.has(threadId) || !accepting) return;
    const pump = async () => {
      await lifecycle?.beforeDispatch?.(threadId);
      await transaction.captures.waitForRecovery(threadId);
      const pendingInspections = inspections.get(threadId);
      inspections.delete(threadId);
      if (replay && pendingInspections)
        for (const saved of pendingInspections) {
          if (!accepting) return;
          const round = readRound(transaction.db, saved.id);
          if (
            round?.attempt.attemptId !== saved.attempt.attemptId ||
            round.attempt.phase.kind !== "recovering" ||
            round.attempt.phase.action !== "inspectInput"
          )
            continue;
          try {
            await inspectOriginalInput(transaction, round, replay);
          } catch {
            /* A failed lookup leaves the original delivery pending. */
          }
        }
      while (accepting) {
        const queue = loadQueue(transaction, threadId);
        const head = firstPending(queue.rows);
        if (!head) return;
        const phase = head.attempt.phase;
        if (phase.kind === "closing") {
          const round = readRound(transaction.db, head.id);
          if (!round) return;
          await transaction.captures.finish(round, true);
          continue;
        }
        if (phase.kind === "unobserved" && phase.seen.kind === "root") {
          if (await recoverRoot(threadId, head.id)) continue;
          return;
        }
        if (
          (phase.kind !== "filed" && phase.kind !== "recovering") ||
          phase.gate === "held" ||
          (phase.kind === "recovering" && phase.action !== "retrySameDelivery")
        )
          return;
        const round = readRound(transaction.db, head.id);
        if (!round) return;
        const saved = codex.forThread(threadId);
        if (saved) {
          const thread = readThread(transaction.db, threadId);
          if (!thread) return;
          const selection = await codex.resolve(saved, actor.id, thread);
          if (!accepting) return;
          if (!selection) {
            const current = readRound(transaction.db, round.id);
            if (current?.version !== round.version) continue;
            discardPrepared(round.id);
            const reason = "Saved executor configuration unavailable";
            transaction.db.transaction(() => {
              transaction.setPhase(current, { kind: "notDelivered", reason, lateReceipt: null });
              advanceQueue(transaction, threadId);
            })();
            const recipient = recipients.get(round.id);
            if (recipient?.readyState === 1)
              recipient.send(
                JSON.stringify({
                  kind: "executor.failed",
                  roundId: round.id,
                  attemptId: round.attempt.attemptId,
                  reason: "invalidState",
                  message: reason,
                } satisfies ExecutorTurnUpdate),
              );
            recipients.delete(round.id);
            continue;
          }
          const ready = prepared.get(round.id);
          prepared.delete(round.id);
          await dispatchCodex(
            transaction,
            round,
            selection,
            () =>
              codex.current(selection.reg.instanceId, actor.id, selection.cwd)?.snapshot ===
              selection.snapshot,
            (event: ExecutorTurnUpdate) => {
              const recipient = recipients.get(round.id);
              if (recipient?.readyState === 1) recipient.send(JSON.stringify(event));
            },
            controller.signal,
            stops,
            steers,
            ready,
          );
        } else if (replay) {
          await dispatchReplay(
            transaction,
            round,
            commandId,
            replay,
            (event) => lifecycle?.update?.(event),
            controller.signal,
            steers,
          );
        } else return;
        const ended = readRound(transaction.db, round.id);
        if (ended?.attempt.phase.kind === "closing")
          await transaction.captures.finish(ended, false);
        recipients.delete(round.id);
        if (readRound(transaction.db, head.id)?.version === round.version) return;
      }
    };
    const run = Bun.sleep(0).then(pump);
    turns.set(threadId, run);
    void run.then(
      () => turns.delete(threadId),
      (error) => {
        turns.delete(threadId);
        console.error(error);
      },
    );
  }
  const openThread = (nonce: string, reportPermissions = false) =>
    threadConnection(
      transaction,
      authHost,
      nonce,
      schedule,
      sendInput,
      gitStatusCache,
      lifecycle?.threadCommand,
      lifecycle?.inspectPage,
      lifecycle?.beforeTodo,
      (actor, cmd) => stops.command({ actor, transaction, commandId: cmd.commandId }, cmd),
      (actor, cmd) => steerInput(actor, cmd),
      lifecycle?.settingReply,
      reportPermissions,
      lifecycle?.beforeInputReceipt,
    );

  async function startThread(
    actor: LocalActor,
    req: Extract<SignedRequest, { method: "thread.start" }>,
  ) {
    const { projectId } = req.payload;
    const id = req.payload.instanceId ?? codex.registry.defaultFor(projectId);
    const cwd = id ? transaction.projectDirectory(projectId) : null;
    let entry = id && cwd ? codex.current(id, actor.id, cwd) : null;
    if (
      id &&
      !entry &&
      actor.allows("thread.send", { kind: "project", projectId }) &&
      !readReceipt(transaction.db, actor.id, req.commandId)
    )
      entry = await codex.lookup(id, actor.id, projectId);
    if (!accepting) throw Error("Writer closed");
    const model = req.payload.model;
    const chosen = codex.select(entry, model);
    return acceptFirstInput({
      verifiedActor: actor,
      commandId: req.commandId,
      threadStart: req.payload,
      transaction,
      validate: () =>
        id
          ? chosen
            ? null
            : "unsupported"
          : replay &&
              (!model || (model.id === replay.modelId && !Object.keys(model.options).length))
            ? null
            : "unsupported",
      selected(roundId) {
        if (chosen)
          transaction.db.run("INSERT INTO round_executors VALUES(?,?,?,?)", [
            roundId,
            chosen.reg.instanceId,
            chosen.reg.version,
            JSON.stringify(chosen.model),
          ]);
      },
    });
  }

  let startupRecovery = Promise.resolve();
  function recover(publish: () => void) {
    const closing = transaction.db
      .query<{ data: string }, []>(
        "SELECT data FROM rounds WHERE json_extract(data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered') AND json_extract(data,'$.attempt.phase.kind')='closing'",
      )
      .all()
      .map(({ data }) => v.parse(RoundSchema, JSON.parse(data)));
    transaction.captures.registerRecovery(closing);
    transaction.diffCleanup.registerRecovery(transaction.recovery);
    const pending = transaction.db
      .query<{ data: string }, []>(
        "SELECT r.data FROM deliveries d JOIN rounds r ON r.id=d.round WHERE (d.pending=1 OR (json_extract(r.data,'$.attempt.phase.kind')='unobserved' AND json_extract(d.frozen,'$.target.family')='codex' AND d.id=json_extract(r.data,'$.attempt.deliveryId'))) AND d.round NOT IN (SELECT round FROM ready_dispatch)",
      )
      .all()
      .map(({ data }) => v.parse(RoundSchema, JSON.parse(data)));
    for (const round of pending) {
      if (
        replay &&
        round.attempt.phase.kind === "recovering" &&
        round.attempt.phase.action === "inspectInput"
      ) {
        const rows = inspections.get(round.threadId) ?? [];
        rows.push(round);
        inspections.set(round.threadId, rows);
      }
    }

    publish();
    const dispatched = Bun.sleep(0);
    startupRecovery = dispatched
      .then(() => transaction.recovery.run(controller.signal))
      .finally(() => {
        startupRecoveryPending = false;
      });

    // The caller can print readiness before recovery or preparation starts synchronous Git.
    void dispatched
      .then(() => {
        if (!accepting) return;
        for (const round of [...closing, ...pending])
          schedule(round.threadId, v.parse(CommandIdSchema, round.attempt.deliveryId));
        for (const { id } of transaction.db
          .query<{ id: string }, []>(
            "SELECT id FROM managed_worktrees WHERE unfinished=1 UNION SELECT worktree AS id FROM ready_dispatch",
          )
          .all()) {
          const m = readManaged(transaction.db, id);
          if (m) resume(m);
        }
      })
      .catch((error) => console.error("Writer dispatch recovery failed", error));
  }
  const timer = setInterval(sweep, selectionSweepMs);
  timer.unref();
  return {
    openThread,
    startThread,
    schedule,
    resume,
    sendInput,
    steerInput,
    stops,
    steers,
    recipients,
    recover,
    get accepting() {
      return accepting;
    },
    get busy() {
      return startupRecoveryPending || !!turns.size || !!preparing.size;
    },
    async close() {
      accepting = false;
      clearInterval(timer);
      gitStatusCache.close();
      controller.abort();

      await Promise.allSettled([
        startupRecovery,
        ...turns.values(),
        ...preparing.values(),
        ...transaction.diffReads,
      ]);
      await Promise.allSettled(opening.values());
      for (const r of prepared.values())
        if (r.opened.kind === "ok") await r.adapter.close(r.opened.value, "shutdown");

      stops.close();
    },
  };
}
