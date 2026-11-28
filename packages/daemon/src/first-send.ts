import { openAccessHost } from "./access";
import { attachFlow, type SocketApplication } from "./flow-socket";
import { inputReads, inputReadMethods } from "./input-reads";
import { createPublicKey, randomBytes, verify } from "node:crypto";
import { openWriterServices } from "./writer-features/lifecycle";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  selectWorktreeBase,
  retryPreparation,
  readManaged,
  applyInputCommand,
  type FirstSendStore,
  inputMethods,
  openStore,
  openWriter,
  measureWriterStartup,
  markStartupDetail,
  type WriterStartupMark,
  readReceipt,
  readRound,
  registerProject,
  settingCommand,
  renameThread,
} from "@kraka/environment";
import {
  checkBusinessUpgrade,
  InboundSettingWriteSchema,
  settingReceiptForVersion,
  SETTING_GENERATION_MINOR,
  type CommandReceipt,
  canonicalJson,
  HostInstanceIdSchema,
  type PermissionItem,
  PermissionItemSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  RequestSignerSchema,
} from "@kraka/protocol";
import * as v from "valibot";
import { threadWork, type ReplayWriter, type WriterLifecycle } from "./thread-work";

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
export function startWriter<H extends object>(
  stateDir: string,
  replay: ReplayWriter<H>,
  lifecycle?: WriterLifecycle,
) {
  return measureWriterStartup((mark) => openDurableWriter(stateDir, replay, lifecycle, mark));
}
async function openDurableWriter<H extends object>(
  stateDir: string,
  replay: ReplayWriter<H>,
  lifecycle: WriterLifecycle | undefined,
  mark: WriterStartupMark,
) {
  const lock = await openWriter(
    stateDir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 10000,
  );
  mark("writerLock");
  if (lock.kind !== "writer") return lock;
  let store: FirstSendStore | undefined;
  let ownedAccess: Awaited<ReturnType<typeof openAccessHost>> | undefined;
  try {
    lifecycle?.locked?.();
    const transaction = openStore(lock.lease, replay?.recovery);
    mark("databaseAndQueues");
    store = transaction;
    if (lifecycle?.capture) transaction.captures.hook = lifecycle.capture;
    lifecycle?.opened?.(transaction);
    markStartupDetail("owner.openedHook");
    const services = openWriterServices(transaction, lifecycle?.families);
    const { executors, stops } = services;
    const owner = v.parse(
      localOwnerSchema,
      JSON.parse(readFileSync(join(lock.lease.stateDirectory, "local-owner.json"), "utf8")),
    );
    markStartupDetail("owner.read");
    const key = createPublicKey(owner.publicKey);
    if (key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
      throw new Error("Local owner requires a P-256 public key");
    const granted = new Set(owner.permissions);
    const actor = {
      id: owner.principalId,
      environmentId: lock.lease.environmentId,
      allows: (permission: PermissionItem) => granted.has(permission),
    };
    markStartupDetail("owner.key");
    mark("owner");
    const authHost = lifecycle?.accessHost ?? (await openAccessHost(stateDir));
    if (!lifecycle?.accessHost) ownedAccess = authHost;
    if (authHost.identity.id !== lock.lease.environmentId)
      throw Error("Access identity conflicts with durable writer");
    mark("access");
    const reads = inputReads(transaction, actor);

    const sockets = new Set<Bun.ServerWebSocket<Session>>();
    const work = threadWork(
      transaction,
      authHost,
      actor,
      executors,
      replay,
      {
        ...lifecycle,
        queueChanged: reads.changed,
      },
      stops,
    );
    const { openThread, startThread, schedule, resume, sendInput, steerInput, steers, recipients } =
      work;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (!work.accepting || url.hostname !== "127.0.0.1")
          return new Response(null, { status: 403 });
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
          if (url.search === "?idle" && work.busy) return new Response(null, { status: 409 });
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
              if (!work.accepting) throw Error("Writer closed");
              ws.data.flow?.peer.input(frame);
              ws.data.flow?.wake();
              return;
            }
            if (!work.accepting || typeof frame !== "string") {
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
                receipt = executors.configure(context, req.payload);
                break;
              case "executor.refresh": {
                const work = executors.refresh(context, req.payload);
                executors.active.add(work);
                try {
                  receipt = await work;
                } finally {
                  executors.active.delete(work);
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
                receipt = await startThread(actor, req);
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
                  executors.forThread(threadId) &&
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
    mark("listener");
    let instance!: ReturnType<typeof lock.publish>;
    try {
      work.recover(() => {
        mark("registerRecovery");
        instance = lock.publish(`ws://127.0.0.1:${server.port}/commands`);
        mark("publish");
      });
    } catch (e) {
      await server.stop(true);
      await work.close();
      throw e;
    }
    return {
      kind: "ready" as const,
      instance,
      openThread,
      async close() {
        if (!work.accepting) return;
        for (const ws of sockets) ws.close(1001);
        try {
          const stopping = work.close();
          await server.stop(true);
          await stopping;
          await services.close();
        } finally {
          try {
            ownedAccess?.close();
            transaction.db.close(true);
          } finally {
            lock.close();
          }
        }
      },
    };
  } catch (e) {
    try {
      ownedAccess?.close();
      store?.db.close();
    } finally {
      lock.close();
    }
    throw e;
  }
}
