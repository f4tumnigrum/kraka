import { inputReads, inputReadMethods } from "./input-reads";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  acceptFirstInput,
  applyInputCommand,
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
  RequestSignerSchema,
  RoundSchema,
  type SignedRequest,
  type ThreadId,
} from "@kraka/protocol";
import * as v from "valibot";
import { type ActiveSteers, dispatchReplay, inspectOriginalInput } from "./durable-replay";

const methods = v.variant("method", [
  REQUEST_METHODS.registerProject.schema,
  REQUEST_METHODS.startThread.schema,
  REQUEST_METHODS.renameThread.schema,
  ...inputReadMethods.map((m) => m.schema),
  ...inputMethods.map((m) => m.schema),
]);
export const localOwnerSchema = v.strictObject({
  principalId: PrincipalIdSchema,
  signer: RequestSignerSchema.options[0],
  publicKey: v.string(),
  permissions: v.array(PermissionItemSchema),
});
type Session = { connectionId: string; challengeId: string; challenge: string; sequence: number };
export async function startWriter<H extends object>(
  stateDir: string,
  replay: {
    adapter: ProviderAdapter<"replay", H>;
    expectedText: string;
    modelId: string;
    recovery?: RecoveryScope;
    confirmFencedAbsence?: (id: import("@kraka/protocol").DeliveryId) => Promise<boolean>;
  },
  lifecycle?: {
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
  try {
    lifecycle?.locked?.();
    const transaction = openStore(lock.lease, replay.recovery);
    store = transaction;
    lifecycle?.opened?.(transaction);
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
    const reads = inputReads(transaction, actor);
    transaction.onQueueChanged = (threadId) => queueMicrotask(() => reads.changed(threadId));
    const sockets = new Set<Bun.ServerWebSocket<Session>>();
    const turns = new Map<string, Promise<void>>();
    const controller = new AbortController();
    let accepting = true;
    const steers: ActiveSteers = new Map();
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
            if (!thread || thread.worktreeId !== null || !frozen) return;
            const capture = v.parse(CheckpointCaptureSchema, {
              id: phase.captureId,
              roundId: head.id,
              attemptId: head.attempt.attemptId,
              version: "1",
              result: { kind: "missing", reason: "noWorktree" },
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
          await dispatchReplay(
            transaction,
            round,
            commandId,
            replay,
            (event) => lifecycle?.update?.(event),
            controller.signal,
            steers,
          );
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
      fetch(req, server) {
        const url = new URL(req.url);
        if (!accepting || req.headers.has("Origin") || url.hostname !== "127.0.0.1")
          return new Response(null, { status: 403 });
        if (/^\/instance\/[0-9a-f]{48}$/.test(url.pathname)) {
          if (url.search === "?idle" && turns.size) return new Response(null, { status: 409 });
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
          const { sequence, ...challenge } = ws.data;
          ws.send(
            JSON.stringify({
              ...challenge,
              instanceId: lock.lease.instanceId,
              environmentId: actor.environmentId,
            }),
          );
        },
        message(ws, frame) {
          try {
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
            const priorSteer =
              req.method === "input.steer" && actor.allows("thread.send")
                ? readReceipt(transaction.db, actor.id, req.commandId)
                : null;
            const receipt =
              req.method === "project.register"
                ? registerProject({ ...context, environmentId: req.environmentId, ...req.payload })
                : req.method === "thread.rename"
                  ? renameThread({ ...context, ...req.payload })
                  : req.method === "thread.start"
                    ? acceptFirstInput({
                        verifiedActor: actor,
                        commandId: req.commandId,
                        threadStart: req.payload,
                        transaction,
                      })
                    : applyInputCommand({
                        actor,
                        transaction,
                        command: req,
                        supportsSteer: (id) => steers.has(id),
                      });
            if (lifecycle?.committed?.(req, receipt) === "disconnect") ws.close(1011);
            else ws.send(JSON.stringify(receipt));
            if (receipt.kind === "accepted") {
              const result = receipt.result;
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
              } else if (result.kind === "threadStarted") schedule(result.threadId, req.commandId);
              else if (req.method.startsWith("input.") && "threadId" in req.payload)
                schedule(req.payload.threadId, req.commandId);
            }
          } catch {
            ws.close(1007);
          }
        },
        close(ws) {
          reads.close(ws);
          sockets.delete(ws);
        },
      },
    });
    let instance: ReturnType<typeof lock.publish>;
    try {
      const pending = transaction.db
        .query<{ data: string }, []>(
          "SELECT r.data FROM deliveries d JOIN rounds r ON r.id=d.round WHERE d.pending=1",
        )
        .all();
      for (const row of pending) {
        const round = v.parse(RoundSchema, JSON.parse(row.data));
        if (
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
    return {
      kind: "ready" as const,
      instance,
      async close() {
        if (!accepting) return;
        accepting = false;
        for (const ws of sockets) ws.close(1001);
        controller.abort();
        try {
          await server.stop(true);
          await Promise.allSettled(turns.values());
        } finally {
          try {
            transaction.db.close();
          } finally {
            lock.close();
          }
        }
      },
    };
  } catch (e) {
    try {
      store?.db.close();
    } finally {
      lock.close();
    }
    throw e;
  }
}
