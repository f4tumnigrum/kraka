import { createPublicKey, verify, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  openWriter,
  openStore,
  registerProject,
  acceptFirstInput,
  renameThread,
  selectWorktreeBase,
  prepareClaim,
  retryPreparation,
  restoreForInput,
  readManaged,
  readReceipt,
  readRound,
  readThread,
  selectionSweepMs,
  type Managed,
  type PreparationHook,
  type FirstSendStore,
  type ProviderAdapter,
} from "@kraka/environment";
import {
  canonicalJson,
  HostInstanceIdSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  RequestSignerSchema,
  type ReplayTurnUpdate,
  PermissionItemSchema,
  type PermissionItem,
  type SignedRequest,
  type CommandReceipt,
} from "@kraka/protocol";
import { dispatchReplay } from "./durable-replay";

const methods = v.variant("method", [
  REQUEST_METHODS.registerProject.schema,
  REQUEST_METHODS.startThread.schema,
  REQUEST_METHODS.renameThread.schema,
  REQUEST_METHODS.prepareWorktree.schema,
  REQUEST_METHODS.retryWorktreeSetup.schema,
  REQUEST_METHODS.sendInput.schema,
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
  replay: { adapter: ProviderAdapter<"replay", H>; expectedText: string; modelId: string },
  lifecycle?: {
    preparation?: PreparationHook;
    locked?: () => void;
    opened?: (store: FirstSendStore) => void;
    committed?: (request: SignedRequest, receipt: CommandReceipt) => void;
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
    const transaction = openStore(lock.lease);
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
    const sockets = new Set<Bun.ServerWebSocket<Session>>();
    const turns = new Map<string, Promise<void>>();
    const controller = new AbortController();
    const sweep = () =>
      transaction.db.run("DELETE FROM worktree_selections WHERE expires<=?", [Date.now()]);
    sweep();
    const schedule = (
      result: Extract<
        Extract<CommandReceipt, { kind: "accepted" }>["result"],
        { kind: "threadStarted" }
      >,
      commandId: SignedRequest["commandId"],
      retry = false,
    ) => {
      const existing = turns.get(result.roundId);
      if (existing) return existing;
      const run = Bun.sleep(0).then(async () => {
        const thread = readThread(transaction.db, result.threadId);
        if (thread?.worktreeId) {
          const m = readManaged(transaction.db, thread.worktreeId);
          if (!m) return;
          await prepareClaim({ claim: m, transaction, hook: lifecycle?.preparation, retry });
        }
        await dispatchReplay(
          transaction,
          result,
          commandId,
          replay,
          (event) => lifecycle?.update?.(event),
          controller.signal,
        );
      });
      turns.set(result.roundId, run);
      void run.then(
        () => turns.delete(result.roundId),
        () => turns.delete(result.roundId),
      );
      return run;
    };
    function resume(m: Managed, retry = false) {
      const round = readRound(transaction.db, m.roundId);
      if (!round) throw Error("Missing first round");
      return schedule(
        {
          kind: "threadStarted",
          threadId: m.claim.threadId,
          roundId: round.id,
          messageId: round.messageId,
          attemptId: round.attempt.attemptId,
          deliveryId: round.attempt.deliveryId,
        },
        m.firstCommand,
        retry,
      );
    }
    let accepting = true;
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
        async message(ws, frame) {
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
              req.protocolVersion.minor !== 0 ||
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
            const priorRetry =
              req.method === "worktree.retrySetup" &&
              readReceipt(transaction.db, actor.id, req.commandId);
            const receipt = await (() => {
              switch (req.method) {
                case "project.register":
                  return registerProject({
                    ...context,
                    environmentId: req.environmentId,
                    ...req.payload,
                  });
                case "thread.rename":
                  return renameThread({ ...context, ...req.payload });
                case "worktree.prepare":
                  return selectWorktreeBase(context, req.payload);
                case "worktree.retrySetup":
                  return retryPreparation(context, req.payload);
                case "input.send":
                  return restoreForInput(context, req.payload, (m) => resume(m));
                case "thread.start":
                  return acceptFirstInput({
                    verifiedActor: actor,
                    commandId: req.commandId,
                    threadStart: req.payload,
                    transaction,
                  });
              }
            })();
            lifecycle?.committed?.(req, receipt);
            ws.send(JSON.stringify(receipt));
            if (receipt.kind === "accepted") {
              if (receipt.result.kind === "threadStarted") schedule(receipt.result, req.commandId);
              if (
                receipt.result.kind === "worktreeStatus" &&
                req.method === "worktree.retrySetup" &&
                !priorRetry
              ) {
                const m = readManaged(transaction.db, receipt.result.view.status.worktreeId);
                if (m) resume(m, req.method === "worktree.retrySetup");
              }
            }
          } catch {
            ws.close(1007);
          }
        },
        close(ws) {
          sockets.delete(ws);
        },
      },
    });
    let instance: ReturnType<typeof lock.publish>;
    try {
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
