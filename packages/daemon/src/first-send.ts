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
            const receipt =
              req.method === "project.register"
                ? registerProject({ ...context, environmentId: req.environmentId, ...req.payload })
                : req.method === "thread.rename"
                  ? renameThread({ ...context, ...req.payload })
                  : acceptFirstInput({
                      verifiedActor: actor,
                      commandId: req.commandId,
                      threadStart: req.payload,
                      transaction,
                    });
            lifecycle?.committed?.(req, receipt);
            ws.send(JSON.stringify(receipt));
            if (
              receipt.kind === "accepted" &&
              receipt.result.kind === "threadStarted" &&
              !turns.has(receipt.result.roundId)
            ) {
              const result = receipt.result;
              const run = Bun.sleep(0).then(() =>
                dispatchReplay(
                  transaction,
                  result,
                  req.commandId,
                  replay,
                  (event) => lifecycle?.update?.(event),
                  controller.signal,
                ),
              );
              turns.set(result.roundId, run);
              void run.finally(() => turns.delete(result.roundId));
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
