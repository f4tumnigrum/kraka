import { createPublicKey, generateKeyPairSync, randomBytes, verify } from "node:crypto";
import * as v from "valibot";
import {
  EXECUTOR_TOOL_METHODS,
  SignedRequestSchema,
  canonicalJson,
  DeliveryIdSchema,
  PrincipalIdSchema,
  type CommandId,
  type CommandReceipt,
  type Round,
  type ThreadId,
  type SignedRequest,
} from "@kraka/protocol";
import {
  invokeExecutorTool,
  readManaged,
  readReceipt,
  readThread,
  type AccessStore,
  type ExecutorSession,
  type ExecutorToolGrant,
  type FirstSendStore,
  type OrdinaryStops,
  type ThreadSessionBinding,
} from "@kraka/environment";
import type { ExecutorInstances, ExecutorSelection } from "./executor-instances";
import { delegatedWork } from "./delegated-work";

type Connection = {
  connectionId: string;
  challengeId: string;
  challenge: string;
  sequence: number;
};
type Installed = {
  grant: ExecutorToolGrant;
  key: ReturnType<typeof createPublicKey>;
  canRead: () => boolean;
  invoke: (request: SignedRequest, observe?: boolean) => CommandReceipt;
};
const toolNames = Object.keys(EXECUTOR_TOOL_METHODS).filter(
  (name): name is keyof typeof EXECUTOR_TOOL_METHODS => Object.hasOwn(EXECUTOR_TOOL_METHODS, name),
);

export class ExecutorToolHost {
  private closed = false;
  private server?: Bun.Server<Connection>;
  private readonly installed = new Map<string, Installed>();
  constructor(
    private readonly store: FirstSendStore,
    private readonly access: AccessStore,
    private readonly executors: ExecutorInstances,
    private readonly stops: OrdinaryStops,
    private readonly schedule: (thread: ThreadId, command: CommandId) => void,
    private readonly prepare: (managed: NonNullable<ReturnType<typeof readManaged>>) => unknown,
  ) {}

  private listen() {
    if (this.server) return this.server;
    const host = this;
    this.server = Bun.serve<Connection>({
      hostname: "127.0.0.1",
      port: 0,
      fetch(req, server) {
        const url = new URL(req.url);
        if (
          req.method === "GET" &&
          !req.headers.has("origin") &&
          url.hostname === "127.0.0.1" &&
          url.pathname === "/tools" &&
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
        return new Response(null, { status: 403 });
      },
      websocket: {
        maxPayloadLength: 1048576,
        open(ws) {
          const { sequence, ...proof } = ws.data;
          ws.send(
            JSON.stringify({
              ...proof,
              environmentId: host.store.writer.environmentId,
              instanceId: host.store.writer.instanceId,
            }),
          );
        },
        async message(ws, frame) {
          try {
            if (typeof frame !== "string") {
              ws.close(1007);
              return;
            }
            const json: unknown = JSON.parse(frame);
            if (JSON.stringify(json) !== frame) {
              ws.close(1007);
              return;
            }
            const req = v.parse(SignedRequestSchema, json);
            const installed = host.installed.get(req.signer.keyId);
            let receipt: CommandReceipt;
            if (!installed)
              receipt = {
                kind: "rejected",
                commandId: req.commandId,
                failure: { kind: "expired" },
              };
            else {
              const { signature, ...body } = req;
              const c = ws.data;
              if (
                req.protocolVersion.major !== 1 ||
                req.protocolVersion.minor !== 0 ||
                req.environmentId !== installed.grant.environmentId ||
                req.signer.kind !== "executor" ||
                req.signer.principalId !== installed.grant.principal.id ||
                req.connectionId !== c.connectionId ||
                req.challengeId !== c.challengeId ||
                req.challenge !== c.challenge ||
                !verify(
                  "sha256",
                  Buffer.from(canonicalJson(body)),
                  { key: installed.key, dsaEncoding: "ieee-p1363" },
                  Buffer.from(signature, "base64url"),
                )
              ) {
                ws.send(
                  JSON.stringify({
                    kind: "rejected",
                    commandId: req.commandId,
                    failure: { kind: "invalidProof" },
                  }),
                );
                ws.close(4001);
                return;
              }
              if (req.sequence !== c.sequence + 1)
                receipt = {
                  kind: "rejected",
                  commandId: req.commandId,
                  failure: { kind: "staleSequence" },
                };
              else {
                c.sequence = req.sequence;
                receipt = await host.call(installed.grant, req);
              }
            }
            if (
              installed &&
              receipt.kind === "accepted" &&
              !host.canDisclose(installed.grant, req)
            ) {
              ws.send(
                JSON.stringify({
                  kind: "rejected",
                  commandId: req.commandId,
                  failure: { kind: "expired" },
                }),
              );
              return;
            }
            ws.send(JSON.stringify(receipt));
          } catch {
            ws.close(1007);
          }
        },
      },
    });
    return this.server;
  }

  async install(
    session: ExecutorSession,
    binding: ThreadSessionBinding,
    round: Round,
    selection: ExecutorSelection,
  ) {
    const support = selection.snapshot.matrix.provideTools;
    if (support.kind === "unsupported" || this.closed) return;
    const thread = readThread(this.store.db, round.threadId);
    if (!thread || !this.access.ensureThread(thread.id, thread.projectId))
      throw Error("Cannot authorize tool thread");
    const delegated = this.store.db
      .query<{ owner: string }, [string]>("SELECT owner FROM child_launches WHERE child=?")
      .get(thread.id);
    const starter = this.store.db
      .query<{ actor: string }, [string]>(
        "SELECT actor FROM receipts WHERE json_extract(data,'$.result.kind')='threadStarted' AND json_extract(data,'$.result.threadId')=? ORDER BY position LIMIT 1",
      )
      .get(thread.id);
    const owner = v.parse(PrincipalIdSchema, delegated?.owner ?? starter?.actor);
    const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const { x, y } = keys.publicKey.export({ format: "jwk" });
    if (!x || !y) throw Error("Invalid tool public key");
    const publicKey = Buffer.concat([
      Buffer.from([4]),
      Buffer.from(x, "base64url"),
      Buffer.from(y, "base64url"),
    ]).toString("base64url");
    const grant = this.store.services.executorTools.register({
      binding,
      roundId: round.id,
      instanceVersion: selection.reg.version,
      publicKey,
      methods: toolNames,
    });
    if (!grant) throw Error("Tool binding changed");
    const handleChild = delegatedWork({
      store: this.store,
      access: this.access,
      executors: this.executors,
      stops: this.stops,
      owner,
      parent: thread,
      selection,
      grant,
    });
    const installed: Installed = {
      grant,
      key: keys.publicKey,
      canRead: () =>
        !!this.access.ceiling(owner, { kind: "thread", threadId: thread.id }, "thread.view"),
      invoke: (request, observe = false) =>
        this.access.db
          .transaction(() =>
            invokeExecutorTool({
              request,
              grant,
              transaction: this.store,
              handleChild,
              observe,
              allows: (id, right) =>
                !!this.access.ceiling(owner, { kind: "thread", threadId: id }, right),
            }),
          )
          .immediate(),
    };
    this.installed.set(grant.keyId, installed);
    const revoke = () => {
      this.installed.delete(grant.keyId);
      this.store.services.executorTools.revoke(grant);
      this.store.sync.notify();
    };
    try {
      const server = this.listen();
      const configuration = {
        environmentId: grant.environmentId,
        instanceId: this.store.writer.instanceId,
        attemptId: grant.principal.attemptId,
        endpoint: `ws://127.0.0.1:${server.port}/tools`,
        signer: { kind: "executor", principalId: grant.principal.id, keyId: grant.keyId },
        privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      };
      const reply = await session.invoke(
        { capabilityVersion: selection.snapshot.version, support },
        {
          kind: "service",
          capability: "provideTools",
          deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
          request: {
            kind: "provideTools",
            tools: toolNames.map((name) => ({ name, configuration })),
          },
        },
      );
      if (reply.kind !== "ok" || reply.value.kind !== "service")
        throw Error("Could not install executor tools");
      return revoke;
    } catch (error) {
      revoke();
      throw error;
    }
  }

  canDisclose(grant: ExecutorToolGrant, request: SignedRequest) {
    const entry = this.installed.get(grant.keyId);
    if (!entry || !this.store.services.executorTools.isCurrent(grant)) return false;
    if (
      request.method === "thread.inspectCheckout" ||
      request.method === "thread.readChild" ||
      request.method === "todo.readAnswer"
    )
      return entry.canRead();
    return true;
  }
  async call(grant: ExecutorToolGrant, request: SignedRequest): Promise<CommandReceipt> {
    const installed = this.installed.get(grant.keyId);
    if (!installed || installed.grant !== grant)
      return { kind: "rejected", commandId: request.commandId, failure: { kind: "expired" } };
    if (
      request.method === "thread.readChild" &&
      request.payload.waitMs &&
      !readReceipt(this.store.db, grant.principal.id, request.commandId)
    ) {
      const wait = Promise.withResolvers<void>();
      const check = () => {
        const result = installed.invoke(request, true);
        if (
          result.kind !== "accepted" ||
          result.result.kind !== "childStatus" ||
          !["working", "queued"].includes(result.result.child.state.kind)
        )
          wait.resolve();
      };
      const undo = this.store.sync.subscribe(check);
      const timer = setTimeout(wait.resolve, request.payload.waitMs);
      try {
        check();
        await wait.promise;
      } finally {
        clearTimeout(timer);
        undo();
      }
    }
    if (this.installed.get(grant.keyId) !== installed)
      return { kind: "rejected", commandId: request.commandId, failure: { kind: "expired" } };
    const result = installed.invoke(request);
    if (result.kind === "accepted") {
      if (result.result.kind === "inputScheduled")
        this.schedule(grant.principal.threadId, request.commandId);
      if (result.result.kind === "childrenAccepted")
        for (const item of result.result.items) {
          if (item.kind !== "accepted") continue;
          const thread = readThread(this.store.db, item.threadId);
          const managed = thread?.worktreeId && readManaged(this.store.db, thread.worktreeId);
          if (
            managed &&
            (managed.claim.phase.kind === "building" || managed.claim.phase.kind === "preparing")
          )
            this.prepare(managed);
          else this.schedule(item.threadId, item.childCommandId);
        }
    }
    return result;
  }

  close() {
    this.closed = true;
    for (const { grant } of this.installed.values())
      this.store.services.executorTools.revoke(grant);
    this.installed.clear();
    this.store.sync.notify();
    this.server?.stop(true);
  }
}
export function executorPublicKey(point: string) {
  const raw = Buffer.from(point, "base64url");
  return createPublicKey({
    format: "jwk",
    key: {
      kty: "EC",
      crv: "P-256",
      x: raw.subarray(1, 33).toString("base64url"),
      y: raw.subarray(33).toString("base64url"),
    },
  });
}
