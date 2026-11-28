import { openAccessHost } from "./access";
import {
  threadConnection,
  type FixtureThreadCommand,
  type FixtureSettingReply,
} from "./thread-connection";
import { attachFlow, type SocketApplication } from "./flow-socket";
import { inputReads, inputReadMethods } from "./input-reads";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { CodexInstances } from "./codex-instances";
import {
  bindingContext,
  dispatchCodex,
  reconcileCodex,
  resumeBinding,
  type PreparedSession,
} from "./durable-codex";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptFirstInput,
  OrdinaryStops,
  savedBinding,
  recordCommand,
  selectWorktreeBase,
  prepareClaim,
  retryPreparation,
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
  inputMethods,
  loadQueue,
  openStore,
  openWriter,
  type ProviderAdapter,
  type RecoveryScope,
  readMessage,
  readReceipt,
  readRound,
  readThread,
  GitStatusCache,
  registerProject,
  settingCommand,
  renameThread,
} from "@kraka/environment";
import {
  checkBusinessUpgrade,
  InboundSettingWriteSchema,
  settingReceiptForVersion,
  SETTING_GENERATION_MINOR,
  type CommandId,
  CommandIdSchema,
  AttemptIdSchema,
  type CommandReceipt,
  canonicalJson,
  HostInstanceIdSchema,
  type PermissionItem,
  PermissionItemSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  type ReplayTurnUpdate,
  type RoundId,
  type ExecutorTurnUpdate,
  RequestSignerSchema,
  RoundSchema,
  type SignedRequest,
  type ThreadId,
} from "@kraka/protocol";
import * as v from "valibot";
import { type ActiveSteers, dispatchReplay, inspectOriginalInput } from "./durable-replay";

const methods = v.variant("method", [
  REQUEST_METHODS.stopRound.schema,
  REQUEST_METHODS.readStop.schema,
  REQUEST_METHODS.configureExecutor.schema,
  REQUEST_METHODS.refreshExecutor.schema,
  REQUEST_METHODS.registerProject.schema,
  REQUEST_METHODS.readSetting.schema,
  InboundSettingWriteSchema,
  REQUEST_METHODS.startThread.schema,
  REQUEST_METHODS.renameThread.schema,
  REQUEST_METHODS.prepareWorktree.schema,
  REQUEST_METHODS.retryWorktreeSetup.schema,
  ...inputReadMethods.map((m) => m.schema),
  ...inputMethods.map((m) => m.schema),
]);
export const localOwnerSchema = v.strictObject({
  principalId: PrincipalIdSchema,
  signer: RequestSignerSchema.options[0],
  publicKey: v.string(),
  permissions: v.array(PermissionItemSchema),
});
type Commands = { connectionId: string; challengeId: string; challenge: string; sequence: number };
type Session = Commands | { app: SocketApplication; flow: ReturnType<typeof attachFlow> | null };
export async function startWriter<H extends object>(
  stateDir: string,
  replay: {
    adapter: ProviderAdapter<"replay", H>;
    expectedText: string;
    modelId: string;
    recovery?: RecoveryScope;
    confirmFencedAbsence?: (id: import("@kraka/protocol").DeliveryId) => Promise<boolean>;
  } | null,
  lifecycle?: {
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
  },
) {
  const lock = await openWriter(
    stateDir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 10000,
  );
  if (lock.kind !== "writer") return lock;
  let store: FirstSendStore | undefined;
  let auth: Awaited<ReturnType<typeof openAccessHost>> | undefined;
  try {
    lifecycle?.locked?.();
    const transaction = openStore(lock.lease, replay?.recovery);
    store = transaction;
    if (lifecycle?.capture) transaction.captures.hook = lifecycle.capture;
    transaction.captures.cleanSettled();
    lifecycle?.opened?.(transaction);
    const codex = new CodexInstances(transaction);
    const stops = new OrdinaryStops(transaction);
    const owner = v.parse(
      localOwnerSchema,
      JSON.parse(readFileSync(join(lock.lease.stateDirectory, "local-owner.json"), "utf8")),
    );
    const key = createPublicKey(owner.publicKey);
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error("Local owner requires a P-256 public key");
    const granted = new Set(owner.permissions);
    const actor = {
      id: owner.principalId,
      environmentId: lock.lease.environmentId,
      allows: (permission: PermissionItem) => granted.has(permission),
    };
    const authHost = await openAccessHost(stateDir);
    auth = authHost;
    const reads = inputReads(transaction, actor);
    const gitStatusCache = new GitStatusCache(Date.now, lifecycle?.gitProcess);

    const sockets = new Set<Bun.ServerWebSocket<Session>>();
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
        reads.changed(threadId);
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
    const recipients = new Map<RoundId, Bun.ServerWebSocket<Session>>();
    function schedule(threadId: ThreadId, commandId: CommandId) {
      if (turns.has(threadId) || !accepting) return;
      const pump = async () => {
        await lifecycle?.beforeDispatch?.(threadId);
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
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (!accepting || url.hostname !== "127.0.0.1") return new Response(null, { status: 403 });
        const origin = req.headers.get("Origin");
        const fixture = lifecycle?.browserFixture;
        if (url.pathname === "/ws") {
          const admission = checkBusinessUpgrade(
            url.pathname + url.search,
            origin !== null ? [origin] : [],
            fixture ? [server.url.origin] : [],
            URL,
          );
          if (admission.kind === "reject") return new Response(null, { status: admission.status });
          const app = await openThread(admission.nonce);
          if (!app) return new Response(null, { status: 403 });
          const observe = lifecycle?.observeFrame;
          if (observe)
            app.write = (wire, send) => {
              const result = send(wire);
              if (result !== 0) observe(app.epoch, wire);
              return result;
            };
          if (server.upgrade(req, { data: { app, flow: null } })) return;
          return new Response(null, { status: 400 });
        }
        if (
          fixture &&
          req.method === "GET" &&
          !url.search &&
          (origin === null || origin === server.url.origin)
        ) {
          const page = fixture(url.pathname);
          if (page) return page;
        }
        if (origin !== null) return new Response(null, { status: 403 });
        if (/^\/instance\/[0-9a-f]{48}$/.test(url.pathname)) {
          if (url.search === "?idle" && (turns.size || preparing.size))
            return new Response(null, { status: 409 });
          const answer = lock.confirm(url.pathname.slice(10) + url.search);
          return new Response(answer, { status: answer ? 200 : 503 });
        }
        if (
          url.pathname === "/commands" &&
          !url.search &&
          server.upgrade(req, {
            data: {
              connectionId: crypto.randomUUID(),
              challengeId: crypto.randomUUID(),
              challenge: randomBytes(32).toString("base64url"),
              sequence: 0,
            },
          })
        )
          return;
        return new Response(null, { status: 404 });
      },
      websocket: {
        data: {} as Session,
        open(ws) {
          sockets.add(ws);
          if ("app" in ws.data) {
            ws.data.flow = attachFlow(ws.data.app, ws);
            return;
          }
          const { sequence, ...challenge } = ws.data;
          ws.send(
            JSON.stringify({
              ...challenge,
              instanceId: lock.lease.instanceId,
              environmentId: actor.environmentId,
            }),
          );
        },
        async message(ws, frame) {
          try {
            if ("app" in ws.data) {
              if (!accepting) throw Error("Writer closed");
              ws.data.flow?.peer.input(frame);
              ws.data.flow?.wake();
              return;
            }
            if (!accepting || typeof frame !== "string") {
              ws.close(1008);
              return;
            }
            const req = v.parse(methods, JSON.parse(frame));
            const { signature, ...body } = req;
            const session = ws.data;
            if (
              req.environmentId !== actor.environmentId ||
              req.protocolVersion.major !== 1 ||
              req.protocolVersion.minor >
                (req.method === "settings.read" || req.method === "settings.write"
                  ? SETTING_GENERATION_MINOR
                  : 1) ||
              req.connectionId !== session.connectionId ||
              req.challengeId !== session.challengeId ||
              req.challenge !== session.challenge ||
              req.sequence !== session.sequence + 1 ||
              !Bun.deepEquals(req.signer, owner.signer) ||
              !verify(
                "sha256",
                Buffer.from(canonicalJson(body)),
                { key, dsaEncoding: "ieee-p1363" },
                Buffer.from(signature, "base64url"),
              )
            ) {
              ws.close(1008);
              return;
            }
            session.sequence = req.sequence;
            const context = { actor, commandId: req.commandId, transaction };
            if (
              req.method === "thread.readHistory" ||
              req.method === "subscription.openThread" ||
              req.method === "subscription.pageSaved" ||
              req.method === "subscription.installed" ||
              req.method === "subscription.close"
            ) {
              reads.request(ws, req);
              return;
            }
            if (req.method === "settings.read" || req.method === "settings.write") {
              ws.send(
                JSON.stringify(
                  settingReceiptForVersion(
                    settingCommand(context, req.method, req.payload),
                    req.protocolVersion.minor,
                  ),
                ),
              );
              return;
            }
            const priorRetry =
              req.method === "worktree.retrySetup" &&
              actor.allows("workspace.change") &&
              readReceipt(transaction.db, actor.id, req.commandId);
            let receipt: CommandReceipt;
            switch (req.method) {
              case "round.stop":
              case "round.readStop":
                receipt = stops.command(context, req);
                break;
              case "worktree.prepare":
                receipt = selectWorktreeBase(context, req.payload);
                break;
              case "worktree.retrySetup":
                receipt = retryPreparation(context, req.payload);
                break;
              case "input.steer":
                receipt = steerInput(actor, req);
                break;
              case "input.send":
                receipt = await sendInput(actor, req);
                break;
              case "executor.configure":
                receipt = codex.registry.configure(context, req.payload);
                break;
              case "executor.refresh": {
                const work = codex.refresh(context, req.payload);
                codex.active.add(work);
                try {
                  receipt = await work;
                } finally {
                  codex.active.delete(work);
                }
                break;
              }
              case "project.register":
                receipt = registerProject({
                  ...context,
                  environmentId: req.environmentId,
                  ...req.payload,
                });
                break;
              case "thread.rename":
                receipt = renameThread({ ...context, ...req.payload });
                break;
              case "thread.start": {
                const { projectId } = req.payload;
                const id = req.payload.instanceId ?? codex.registry.defaultFor(projectId);
                const cwd = id ? transaction.projectDirectory(projectId) : null;
                let entry = id && cwd ? codex.current(id, actor.id, cwd) : null;
                if (
                  id &&
                  !entry &&
                  actor.allows("thread.send") &&
                  !readReceipt(transaction.db, actor.id, req.commandId)
                )
                  entry = await codex.lookup(id, actor.id, projectId);
                if (!accepting) return;
                const model = req.payload.model;
                const chosen = codex.select(entry, model);
                receipt = acceptFirstInput({
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
                          (!model ||
                            (model.id === replay.modelId && !Object.keys(model.options).length))
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
                break;
              }
              default:
                receipt = applyInputCommand({
                  actor,
                  transaction,
                  command: req,
                  supportsSteer: (id) => steers.has(id),
                });
            }
            if (lifecycle?.committed?.(req, receipt) === "disconnect") ws.close(1011);
            else ws.send(JSON.stringify(receipt));
            if (receipt.kind === "accepted") {
              const result = receipt.result;
              if (
                (result.kind === "threadStarted" || result.kind === "inputScheduled") &&
                !(req.method === "input.steer" && req.payload.mode === "insertCurrent")
              ) {
                const threadId =
                  result.kind === "threadStarted"
                    ? result.threadId
                    : "threadId" in req.payload
                      ? req.payload.threadId
                      : null;
                if (
                  threadId &&
                  codex.forThread(threadId) &&
                  readRound(transaction.db, result.roundId)?.attempt.phase.kind === "filed"
                )
                  recipients.set(result.roundId, ws);
              }
              if (result.kind === "threadStarted") {
                const worktreeId = req.method === "thread.start" && req.payload.worktreeId;
                const managed = worktreeId && readManaged(transaction.db, worktreeId);
                if (
                  managed &&
                  (managed.claim.phase.kind === "building" ||
                    managed.claim.phase.kind === "preparing")
                )
                  void resume(managed);
                else schedule(result.threadId, req.commandId);
              } else if (
                req.method === "worktree.retrySetup" &&
                !priorRetry &&
                result.kind === "worktreeStatus"
              ) {
                const m = readManaged(transaction.db, req.payload.worktreeId);
                if (m) void resume(m, true);
              } else if (
                req.method.startsWith("input.") &&
                req.method !== "input.steer" &&
                "threadId" in req.payload
              )
                schedule(req.payload.threadId, req.commandId);
            }
          } catch {
            ws.close(1007);
          }
        },
        drain(ws) {
          if ("app" in ws.data) {
            ws.data.flow?.peer.drain();
            ws.data.flow?.wake();
          }
        },
        close(ws) {
          if ("app" in ws.data) ws.data.flow?.dispose();
          for (const [roundId, socket] of recipients) if (socket === ws) recipients.delete(roundId);
          reads.close(ws);
          sockets.delete(ws);
        },
      },
    });
    let instance: ReturnType<typeof lock.publish>;
    try {
      await transaction.captures.recoverBaselines();
      for (const { data } of transaction.db
        .query<{ data: string }, []>(
          "SELECT data FROM rounds WHERE json_extract(data,'$.attempt.phase.kind')='closing'",
        )
        .all()) {
        const r = v.parse(RoundSchema, JSON.parse(data));
        schedule(r.threadId, v.parse(CommandIdSchema, r.attempt.deliveryId));
      }
      const pending = transaction.db
        .query<{ data: string }, []>(
          "SELECT r.data FROM deliveries d JOIN rounds r ON r.id=d.round WHERE (d.pending=1 OR (json_extract(r.data,'$.attempt.phase.kind')='unobserved' AND json_extract(d.frozen,'$.target.family')='codex' AND d.id=json_extract(r.data,'$.attempt.deliveryId'))) AND d.round NOT IN (SELECT round FROM ready_dispatch)",
        )
        .all();
      for (const row of pending) {
        const round = v.parse(RoundSchema, JSON.parse(row.data));
        if (
          replay &&
          round.attempt.phase.kind === "recovering" &&
          round.attempt.phase.action === "inspectInput"
        ) {
          try {
            await inspectOriginalInput(transaction, round, replay);
          } catch {
            /* A failed lookup leaves the old delivery pending. */
          }
        }
        schedule(round.threadId, v.parse(CommandIdSchema, round.attempt.deliveryId));
      }
      instance = lock.publish(`ws://127.0.0.1:${server.port}/commands`);
    } catch (e) {
      await server.stop(true);
      throw e;
    }
    const timer = setInterval(sweep, selectionSweepMs);
    timer.unref();
    for (const { id } of transaction.db
      .query<{ id: string }, []>(
        "SELECT id FROM managed_worktrees WHERE unfinished=1 UNION SELECT worktree AS id FROM ready_dispatch",
      )
      .all()) {
      const m = readManaged(transaction.db, id);
      if (m) resume(m);
    }
    return {
      kind: "ready" as const,
      instance,
      openThread,
      async close() {
        if (!accepting) return;
        accepting = false;
        clearInterval(timer);
        gitStatusCache.close();
        for (const ws of sockets) ws.close(1001);
        controller.abort();
        try {
          await server.stop(true);
          await Promise.allSettled([...turns.values(), ...preparing.values()]);
          await Promise.allSettled(opening.values());
          for (const r of prepared.values())
            if (r.opened.kind === "ok") await r.adapter.close(r.opened.value, "shutdown");
          stops.close();
          await codex.close();
        } finally {
          try {
            authHost.close();
            transaction.db.close(true);
          } finally {
            lock.close();
          }
        }
      },
    };
  } catch (e) {
    try {
      auth?.close();
      store?.db.close();
    } finally {
      lock.close();
    }
    throw e;
  }
}
