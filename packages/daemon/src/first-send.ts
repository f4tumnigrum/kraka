import { openAccessHost } from "./access";
import { threadConnection, type FixtureThreadCommand } from "./thread-connection";
import { attachFlow, type SocketApplication } from "./flow-socket";
import { checkBusinessUpgrade } from "@kraka/protocol";
import { CodexInstances, type CodexSelection } from "./codex-instances";
import { dispatchCodex } from "./durable-codex";
import { createPublicKey, verify, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  readReceipt,
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
  REQUEST_METHODS.configureExecutor.schema,
  REQUEST_METHODS.refreshExecutor.schema,
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
type Commands = { connectionId: string; challengeId: string; challenge: string; sequence: number };
type Session = Commands | { app: SocketApplication; flow: ReturnType<typeof attachFlow> | null };
export async function startWriter<H extends object>(
  stateDir: string,
  replay: { adapter: ProviderAdapter<"replay", H>; expectedText: string; modelId: string } | null,
  lifecycle?: {
    inspectPage?: (
      page: import("@kraka/protocol").SubscriptionPage,
    ) => import("@kraka/protocol").SubscriptionPage;
    threadCommand?: FixtureThreadCommand;
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
  let auth: Awaited<ReturnType<typeof openAccessHost>> | undefined;
  try {
    lifecycle?.locked?.();
    const transaction = openStore(lock.lease);
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
    const sockets = new Set<Bun.ServerWebSocket<Session>>();
    const turns = new Map<string, Promise<void>>();
    const controller = new AbortController();
    let accepting = true;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(req, server) {
        const url = new URL(req.url);
        if (!accepting || req.headers.has("Origin") || url.hostname !== "127.0.0.1")
          return new Response(null, { status: 403 });
        if (url.pathname === "/ws") {
          const admission = checkBusinessUpgrade(url.pathname + url.search, [], [], URL);
          if (admission.kind === "reject") return new Response(null, { status: admission.status });
          const app = await threadConnection(
            transaction,
            authHost,
            admission.nonce,
            lifecycle?.threadCommand,
            lifecycle?.inspectPage,
          );
          if (!app) return new Response(null, { status: 403 });
          if (server.upgrade(req, { data: { app, flow: null } })) return;
          return new Response(null, { status: 400 });
        }
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
            let selection: CodexSelection | null = null;
            let receipt: CommandReceipt;
            switch (req.method) {
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
                selection = codex.select(entry, model);
                const chosen = selection;
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
            }
            lifecycle?.committed?.(req, receipt);
            ws.send(JSON.stringify(receipt));
            if (
              receipt.kind === "accepted" &&
              receipt.result.kind === "threadStarted" &&
              !turns.has(receipt.result.roundId)
            ) {
              const result = receipt.result;
              const chosen = selection;
              const saved = transaction.db
                .query<{ instance: string; version: string; model: string }, [string]>(
                  "SELECT instance,version,model FROM round_executors WHERE round=?",
                )
                .get(result.roundId);
              const run = Bun.sleep(0).then(async () => {
                if (saved) {
                  if (
                    chosen &&
                    chosen.reg.instanceId === saved.instance &&
                    chosen.reg.version === saved.version &&
                    Bun.deepEquals(JSON.parse(saved.model), chosen.model)
                  )
                    await dispatchCodex(
                      transaction,
                      result,
                      chosen,
                      () =>
                        codex.current(chosen.reg.instanceId, actor.id, chosen.cwd)?.snapshot ===
                        chosen.snapshot,
                      (event) => {
                        if (ws.readyState === 1) ws.send(JSON.stringify(event));
                      },
                      controller.signal,
                    );
                } else if (replay)
                  await dispatchReplay(
                    transaction,
                    result,
                    req.commandId,
                    replay,
                    (event) => lifecycle?.update?.(event),
                    controller.signal,
                  );
              });
              turns.set(result.roundId, run);
              void run.finally(() => turns.delete(result.roundId));
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
