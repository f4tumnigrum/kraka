import { openAccessHost } from "./access";
import { threadConnection, type FixtureThreadCommand } from "./thread-connection";
import { attachFlow, type SocketApplication } from "./flow-socket";
import { inputReads, inputReadMethods } from "./input-reads";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { CodexInstances } from "./codex-instances";
import { dispatchCodex } from "./durable-codex";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptFirstInput,
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
  frozenInput,
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
  recordInputEvidence,
  registerProject,
  renameThread,
} from "@kraka/environment";
import {
  checkBusinessUpgrade,
  CheckpointCaptureSchema,
  type CommandId,
  CommandIdSchema,
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
  REQUEST_METHODS.configureExecutor.schema,
  REQUEST_METHODS.refreshExecutor.schema,
  REQUEST_METHODS.registerProject.schema,
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
    browserListFixture?: boolean;
    inspectPage?: (
      page: import("@kraka/protocol").SubscriptionPage,
    ) => import("@kraka/protocol").SubscriptionPage;
    threadCommand?: FixtureThreadCommand;
    beforeTodo?: (id: CommandId, proceed: () => void) => void;
    beforeDispatch?: (thread: ThreadId) => Promise<void>;
    locked?: () => void;
    opened?: (store: FirstSendStore) => void;
    committed?: (request: SignedRequest, receipt: CommandReceipt) => void | "disconnect";
    update?: (event: ReplayTurnUpdate) => void;
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
    lifecycle?.opened?.(transaction);
    const codex = new CodexInstances(transaction);
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
    transaction.onQueueChanged = (threadId) => queueMicrotask(() => reads.changed(threadId));
    const sockets = new Set<Bun.ServerWebSocket<Session>>();
    const turns = new Map<string, Promise<void>>();
    const controller = new AbortController();
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
    const sendInput = (
      actor: LocalActor,
      command: Extract<SignedRequest, { method: "input.send" }>,
    ) =>
      restoreForInput(
        { actor, transaction, commandId: command.commandId },
        command.payload,
        (m) => resume(m),
        () => applyInputCommand({ actor, transaction, command }),
      );
    let accepting = true;
    const steers: ActiveSteers = new Map();
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
          if (
            phase.kind === "closing" &&
            queue.rows.some((r) => r.attempt.phase.kind === "filed")
          ) {
            const thread = readThread(transaction.db, threadId);
            const frozen = frozenInput(transaction, head.attempt.deliveryId);
            if (!thread || !frozen) return;
            const capture = v.parse(CheckpointCaptureSchema, {
              id: phase.captureId,
              roundId: head.id,
              attemptId: head.attempt.attemptId,
              version: "1",
              result: {
                kind: "missing",
                reason: thread.worktreeId ? "captureMissing" : "noWorktree",
              },
            });
            const settled = transaction.db.transaction(() => {
              const evidence = recordInputEvidence(transaction, frozen.target, {
                ...head.attempt,
                kind: "captureSettled",
                capture,
              });
              if (evidence.kind === "ok")
                transaction.db.run("INSERT OR REPLACE INTO turn_work VALUES(?,?,?)", [
                  head.id,
                  "capture",
                  JSON.stringify(capture),
                ]);
              return evidence;
            })();
            if (settled.kind === "rejected") return;
            continue;
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
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (
          !accepting ||
          (req.headers.has("Origin") &&
            (!lifecycle?.browserListFixture || url.pathname !== "/ws")) ||
          url.hostname !== "127.0.0.1"
        )
          return new Response(null, { status: 403 });
        if (url.pathname === "/ws") {
          const admission = checkBusinessUpgrade(
            url.pathname + url.search,
            req.headers.has("Origin") ? [req.headers.get("Origin")!] : [],
            lifecycle?.browserListFixture ? ["http://127.0.0.1:" + server.port] : [],
            URL,
          );
          if (admission.kind === "reject") return new Response(null, { status: admission.status });
          const app = await threadConnection(
            transaction,
            authHost,
            admission.nonce,
            schedule,
            sendInput,
            lifecycle?.threadCommand,
            lifecycle?.inspectPage,
            lifecycle?.beforeTodo,
          );
          if (!app) return new Response(null, { status: 403 });
          if (server.upgrade(req, { data: { app, flow: null } })) return;
          return new Response(null, { status: 400 });
        }
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
              req.protocolVersion.minor > 1 ||
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
            const priorRetry =
              req.method === "worktree.retrySetup" &&
              actor.allows("workspace.change") &&
              readReceipt(transaction.db, actor.id, req.commandId);
            const priorSteer =
              req.method === "input.steer" && actor.allows("thread.send")
                ? readReceipt(transaction.db, actor.id, req.commandId)
                : null;
            let receipt: CommandReceipt;
            switch (req.method) {
              case "worktree.prepare":
                receipt = selectWorktreeBase(context, req.payload);
                break;
              case "worktree.retrySetup":
                receipt = retryPreparation(context, req.payload);
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
                const { projectId, model } = req.payload;
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
              if (
                req.method === "input.steer" &&
                req.payload.mode === "insertCurrent" &&
                result.kind === "inputScheduled"
              ) {
                const send = steers.get(result.attemptId);
                const message = readMessage(transaction.db, result.messageId);
                if (!priorSteer && send && message)
                  void send(
                    {
                      id: message.id,
                      text: message.text,
                      references: message.references,
                      attachments: message.attachments,
                    },
                    result.deliveryId,
                  ).catch(() => {});
              } else if (result.kind === "threadStarted") {
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
              } else if (req.method.startsWith("input.") && "threadId" in req.payload)
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
      const pending = transaction.db
        .query<{ data: string }, []>(
          "SELECT r.data FROM deliveries d JOIN rounds r ON r.id=d.round WHERE d.pending=1 AND d.round NOT IN (SELECT round FROM ready_dispatch)",
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
      async close() {
        if (!accepting) return;
        accepting = false;
        clearInterval(timer);
        for (const ws of sockets) ws.close(1001);
        controller.abort();
        try {
          await server.stop(true);
          await Promise.allSettled([...turns.values(), ...preparing.values()]);
          await codex.close();
        } finally {
          try {
            authHost.close();
            transaction.db.close();
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
