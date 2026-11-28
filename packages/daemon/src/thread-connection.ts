import { createPublicKey, randomBytes, verify } from "node:crypto";
import * as v from "valibot";
import {
  canonicalJson,
  DEFAULT_DEVICE_PERMISSIONS,
  sendLogicalRequest,
  type PermissionItem,
  type PrivateSecretRequest,
  PAIRING_LIMITS,
  ConnectionIdSchema,
  ServerHelloSchema,
  SessionAuthorizedSchema,
  TRANSPORT_LIMITS,
  TOOL_ACTIVITY_DETAIL_MINOR,
  RequestUploads,
  sendLogicalControl,
  SETTING_GENERATION_MINOR,
  settingReceiptForVersion,
  type SubscriptionPage,
  type SessionAuthorized,
  type SignedRequest,
  type InboundSettingWrite,
  type ClientAuthentication,
  type ThreadId,
  type ProjectId,
  type CommandReceipt,
  type CommandId,
  DiffResultSchema,
  type WorkspaceTargetSchema,
  workspaceAuthorizationTarget,
} from "@kraka/protocol";
import {
  acceptTodoReply,
  type GitStatusCache,
  LocalDiffService,
  applyInputCommand,
  type LocalActor,
  readProject,
  readThread,
  renameThread,
  resolveDiffDirectory,
  settingCommand,
  watchSettingFile,
  applyThreadChange,
  type FirstSendStore,
} from "@kraka/environment";
import { ThreadSubscriptions } from "./thread-subscriptions";
import { GitStatusSubscriptions } from "./git-status-subscriptions";
import type { openAccessHost } from "./access";
import type { SocketApplication } from "./flow-socket";

export type FixtureThreadCommand = (
  request: SignedRequest,
  store: FirstSendStore,
) => CommandReceipt | null;
export type SettingIngress =
  | Extract<SignedRequest, { method: "settings.read" }>
  | InboundSettingWrite;
export type FixtureSettingReply = (
  req: SettingIngress,
  execute: () => CommandReceipt,
) => CommandReceipt;
type Access = Awaited<ReturnType<typeof openAccessHost>>;
type WorkspaceTarget = v.InferOutput<typeof WorkspaceTargetSchema>;
export async function threadConnection(
  store: FirstSendStore,
  host: Access,
  nonce: string,
  schedule: (threadId: ThreadId, commandId: CommandId) => void,
  sendInput: (
    actor: LocalActor,
    command: Extract<SignedRequest, { method: "input.send" }>,
  ) => Promise<CommandReceipt>,
  gitStatusCache: GitStatusCache,
  fixtureCommand?: FixtureThreadCommand,
  inspectPage?: (page: SubscriptionPage) => SubscriptionPage,
  beforeTodo?: (id: CommandId, proceed: () => void) => void,
  stopCommand?: (
    actor: LocalActor,
    command: import("@kraka/environment").StopCommand,
  ) => CommandReceipt,
  steerCommand?: (
    actor: LocalActor,
    command: Extract<SignedRequest, { method: "input.steer" }>,
  ) => CommandReceipt,
  settingReply?: FixtureSettingReply,
  reportPermissions = false,
  beforeInputReceipt?: (
    request: SignedRequest,
    receipt: CommandReceipt,
    deliver: () => void,
  ) => void,
): Promise<SocketApplication | null> {
  if (host.identity.id !== store.writer.environmentId) return null;
  const epoch = v.parse(ConnectionIdSchema, crypto.randomUUID());
  const fields = {
    kind: "server.hello",
    connectionId: epoch,
    challengeId: crypto.randomUUID(),
    challenge: randomBytes(32).toString("base64url"),
    clientNonce: nonce,
    protocolVersion: {
      major: 1,
      minor: Math.max(TOOL_ACTIVITY_DETAIL_MINOR, SETTING_GENERATION_MINOR),
    },
    features: [
      "strictSchemas",
      "signedRequests",
      "objectReplacementSync",
      "perStreamFlowControl",
      "binaryContentChunks",
      "timelineItems",
      "directoryDiff",
      "privateSecretSubmission",
      "queueEditing",
    ],
    identity: host.identity,
  };
  const hello = v.parse(ServerHelloSchema, {
    ...fields,
    identityProof: await host.port.sign(canonicalJson(fields)),
  });
  const issued = Date.now();
  let check = () => {};
  return {
    epoch,
    beforeSend: () => check(),
    attach(peer, wake) {
      let watching: string | null = null,
        stopWatching: (() => void) | undefined;
      let seq = 0,
        session: SessionAuthorized | null = null,
        subs: ThreadSubscriptions | null = null,
        gitStatus: GitStatusSubscriptions | null = null;
      const uploads = new RequestUploads(peer);
      const disclosures = new Map<
        CommandId,
        { stream: number | undefined; allowed: () => boolean }
      >();
      let boundKey: ReturnType<typeof createPublicKey> | null = null;
      function usable(signer: ClientAuthentication["signer"]) {
        const d = host.port.registration(signer);
        return d &&
          signer.kind === "device" &&
          d.keyId === signer.keyId &&
          d.deviceKey.state.kind === "usable" &&
          d.deviceKey.state.expiresAt > Date.now()
          ? d
          : null;
      }
      const allowsTarget = (
        target: { kind: "thread"; threadId: ThreadId } | { kind: "project"; projectId: ProjectId },
        permission: PermissionItem,
      ) => {
        if (!session || !usable(session.signer)) return false;
        if (target.kind === "thread") {
          const thread = readThread(store.db, target.threadId);
          if (!thread || !host.store.ensureThread(target.threadId, thread.projectId)) return false;
        } else {
          const project = readProject(store.db, target.projectId);
          if (!project || project.environmentId !== host.identity.id) return false;
          host.store.provisionProject(target.projectId);
        }
        return !!host.store.ceiling(session.principal.id, target, permission);
      };
      function visibility() {
        const n = host.store.db
          .query<{ n: string }, []>("SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) n FROM changes")
          .get()?.n;
        return JSON.stringify([session?.principal.id, n]);
      }
      const allows = (threadId: ThreadId, permission: PermissionItem) =>
        allowsTarget({ kind: "thread", threadId }, permission);
      const allowsWorkspace = (target: WorkspaceTarget) =>
        allowsTarget(workspaceAuthorizationTarget(target), "thread.view");
      const diffService = new LocalDiffService(store.diffCleanup);
      async function readDiff(
        request: Extract<SignedRequest, { method: "checkpoint.diff" }>,
      ): Promise<CommandReceipt> {
        const { commandId } = request;
        const { query, cursor } = request.payload;
        const unavailable = (reason: string) =>
          v.parse(DiffResultSchema, {
            kind: "unavailable",
            request: query,
            from: null,
            to: null,
            reason,
          });
        if (!allows(query.threadId, "thread.view"))
          return { kind: "rejected", commandId, failure: { kind: "notFound" } };
        const directoryDiff = session?.features.includes("directoryDiff") ?? false;
        if ("directoryId" in query && !directoryDiff)
          return {
            kind: "rejected",
            commandId,
            failure: { kind: "unsupported" },
          };
        const directory = resolveDiffDirectory(store, query);
        const actor = { scope: visibility(), directoryDiff };
        const diff = !directory
          ? unavailable("invalidated")
          : query.kind === "round" || query.kind === "roundRange"
            ? await store.captures.readCaptureRange({
                thread: query.threadId,
                worktree: directory,
                fromCaptureId: query.kind === "round" ? query.captureId : query.fromCaptureId,
                toCaptureId: query.kind === "round" ? query.captureId : query.toCaptureId,
                single: query.kind === "round",
                cursor,
                actor,
                reader: diffService,
              })
            : await diffService.readLocalDiff({
                actor,
                query,
                cursor,
                resolvedDirectory: directory,
              });
        return { kind: "accepted", commandId, result: { kind: "checkpointDiff", diff } };
      }
      function accept(
        m: SignedRequest | InboundSettingWrite | PrivateSecretRequest | ClientAuthentication,
      ) {
        const actor = usable(m.signer);
        if (
          !actor ||
          m.environmentId !== host.identity.id ||
          m.connectionId !== epoch ||
          m.challenge !== hello.challenge ||
          m.challengeId !== hello.challengeId ||
          m.protocolVersion.major !== 1 ||
          m.protocolVersion.minor > hello.protocolVersion.minor ||
          (session && m.protocolVersion.minor !== session.protocolVersion.minor) ||
          m.sequence !== seq + 1 ||
          (session && canonicalJson(m.signer) !== canonicalJson(session.signer))
        )
          throw Error("Invalid signed session");
        if (!boundKey) {
          const point = Buffer.from(actor.publicKey, "base64url");
          boundKey = createPublicKey({
            key: {
              kty: "EC",
              crv: "P-256",
              x: point.subarray(1, 33).toString("base64url"),
              y: point.subarray(33).toString("base64url"),
            },
            format: "jwk",
          });
        }
        const { signature, ...body } = m;
        if (
          !verify(
            "sha256",
            Buffer.from(canonicalJson(body)),
            { key: boundKey, dsaEncoding: "ieee-p1363" },
            Buffer.from(signature, "base64url"),
          )
        )
          throw Error("Invalid request signature");
        seq = m.sequence;
        if (m.kind === "client.authenticate") {
          if (
            session ||
            Date.now() - issued > PAIRING_LIMITS.challengeMs ||
            m.clientNonce !== nonce ||
            m.features.some((f) => !hello.features.includes(f)) ||
            new Set(m.features).size !== m.features.length
          )
            throw Error("Invalid negotiation");
          if (
            !m.features.includes("perStreamFlowControl") ||
            !m.features.includes("objectReplacementSync")
          )
            throw Error("Unsupported sync configuration");
          session = v.parse(SessionAuthorizedSchema, {
            kind: "session.authorized",
            environmentId: host.identity.id,
            connectionId: epoch,
            environmentSessionId: crypto.randomUUID(),
            principal: actor.principal,
            signer: m.signer,
            authorizedAt: Date.now(),
            protocolVersion: m.protocolVersion,
            features: m.features,
          });
          peer.control(session);
          peer.control({
            ...host.port.configuration,
            kind: "session.configuration",
            connectionId: epoch,
            environmentSessionId: session.environmentSessionId,
            transportLimits: TRANSPORT_LIMITS,
          });
          subs = new ThreadSubscriptions(
            peer,
            wake,
            store,
            {
              principal: actor.principal.id,
              visibility,
              canList: (projectId) => {
                if (!session || !usable(session.signer)) return false;
                if (
                  projectId &&
                  !host.store.db
                    .query("SELECT 1 FROM objects WHERE kind='project' AND id=?")
                    .get(projectId)
                ) {
                  if (!store.db.query("SELECT 1 FROM projects WHERE id=?").get(projectId))
                    return false;
                  host.store.provisionProject(projectId);
                }
                const target = projectId
                  ? { kind: "project" as const, projectId }
                  : { kind: "environment" as const, environmentId: host.identity.id };
                return !!host.store.ceiling(actor.principal.id, target, "thread.view");
              },
              canAnswer: (todo) => {
                if (
                  todo.state.kind !== "open" ||
                  (todo.state.route.kind === "live" && !store.todos.isLive(todo))
                )
                  return false;
                if (todo.body.kind === "approval") {
                  const right = store.todos.get(todo.id)?.binding.approval?.permission;
                  return (
                    !!right && allows(todo.threadId, right) && allows(todo.threadId, "owner.decide")
                  );
                }
                return allows(
                  todo.threadId,
                  todo.body.kind === "question" ? "thread.reply" : "owner.decide",
                );
              },
              ...(reportPermissions
                ? {
                    permissions: (id: ThreadId) =>
                      DEFAULT_DEVICE_PERMISSIONS.filter((right) => allows(id, right)),
                  }
                : {}),
              canRead: (id) => allows(id, "thread.view"),
              timelineItems: m.features.includes("timelineItems"),
              directoryDiff: m.features.includes("directoryDiff"),
              protocolMinor: m.protocolVersion.minor,
            },
            inspectPage,
          );
          gitStatus = new GitStatusSubscriptions(
            peer,
            wake,
            store,
            host.identity.id,
            allowsWorkspace,
            gitStatusCache,
            (id) => subs?.has(id) ?? false,
          );
        } else {
          if (!session || !subs) throw Error("Configuration required");
          if (m.method === "settings.read" || m.method === "settings.write") {
            const principal = actor.principal.id;
            const local: LocalActor = {
              id: principal,
              environmentId: host.identity.id,
              allows(permission, target) {
                if (target.kind === "project") {
                  if (!readProject(store.db, target.projectId)) return false;
                  host.store.provisionProject(target.projectId);
                }
                return !!host.store.ceiling(principal, target, permission);
              },
            };
            const execute = () =>
              settingCommand(
                { actor: local, transaction: store, commandId: m.commandId },
                m.method,
                m.payload,
              );
            const receipt = settingReply ? settingReply(m, execute) : execute();
            if (
              receipt.kind === "accepted" &&
              (receipt.result.kind === "settingRead" || receipt.result.kind === "settingSaved")
            ) {
              const rb = receipt.result.readback,
                context = rb.checkout ?? rb.target;
              const key = context.kind === "checkout" ? canonicalJson(context) : null;
              if (key !== watching) {
                stopWatching?.();
                watching = key;
                stopWatching =
                  context.kind === "checkout" ? watchSettingFile(store, context) : undefined;
              }
            }
            sendLogicalControl(peer, settingReceiptForVersion(receipt, m.protocolVersion.minor));
            return;
          }
          if (
            m.method === "todo.answer" ||
            m.method === "todo.decide" ||
            m.method === "todo.readAnswer" ||
            m.method === "todo.readSecretReceipt" ||
            m.method === "todo.submitSecret"
          ) {
            const proceed = () => {
              const result = host.store.db
                .transaction(() =>
                  acceptTodoReply({
                    verifiedActor: {
                      id: actor.principal.id,
                      deviceId: actor.deviceId,
                      environmentId: host.identity.id,
                      allows: (permission, target) =>
                        target.kind === "thread" && allows(target.threadId, permission),
                    },
                    signedCommand: m,
                    writer: store,
                  }),
                )
                .immediate();
              const stream = sendLogicalRequest(peer, result);
              const thread =
                m.method === "todo.submitSecret" ? m.payload.target.threadId : m.payload.threadId;
              if (
                result.kind === "accepted" &&
                (result.result.kind === "todoAnswerRead" || result.result.kind === "secretReceipt")
              ) {
                const right =
                  result.result.kind === "secretReceipt" ? "owner.decide" : "thread.view";
                disclosures.set(m.commandId, { stream, allowed: () => allows(thread, right) });
              } else if (result.kind === "rejected" && result.failure.kind === "todoChanged") {
                const required = m.method === "todo.answer" ? "thread.reply" : "owner.decide";
                const action = store.todos.get(result.failure.current.id)?.binding.approval
                  ?.permission;
                disclosures.set(m.commandId, {
                  stream,
                  allowed: () =>
                    allows(thread, "thread.view") &&
                    allows(thread, required) &&
                    (!action || allows(thread, action)),
                });
              }
              if (result.kind === "accepted" && result.result.kind === "todoAnswerStored") {
                const todo = store.todos.get(result.result.todoRequestId)?.todo;
                if (todo?.state.kind === "answered" && todo.state.route.kind === "message")
                  schedule(todo.threadId, m.commandId);
              }
              wake();
            };
            if (beforeTodo && (m.method === "todo.answer" || m.method === "todo.decide"))
              beforeTodo(m.commandId, proceed);
            else proceed();
            return;
          }
          let result = gitStatus?.handle(m) ?? null;
          if (
            !result &&
            (m.method === "subscription.openThread" ||
              m.method === "subscription.openList" ||
              m.method === "tool.readActivity") &&
            gitStatus?.has(m.payload.subscriptionId)
          )
            result = {
              kind: "rejected",
              commandId: m.commandId,
              failure: { kind: "invalidState" },
            };
          if (m.method === "checkpoint.diff") {
            const scope = visibility();
            const allowed = () =>
              scope === visibility() && allows(m.payload.query.threadId, "thread.view");
            const work = readDiff(m)
              .then((receipt) => {
                if (!session) return;
                if (receipt.kind === "accepted" && !allowed())
                  peer.control({
                    kind: "rejected",
                    commandId: m.commandId,
                    failure: { kind: "notFound" },
                  });
                else {
                  const stream = sendLogicalRequest(peer, receipt);
                  if (receipt.kind === "accepted")
                    disclosures.set(m.commandId, { stream, allowed });
                }
                wake();
              })
              .catch(() => {
                if (session) {
                  peer.control({
                    kind: "programError",
                    commandId: m.commandId,
                    code: "internalError",
                  });
                  wake();
                }
              });
            store.diffReads.add(work);
            void work.finally(() => store.diffReads.delete(work));
            return;
          }
          if (!result) result = subs.handle(m);
          if (
            !result &&
            (m.method === "round.stop" ||
              m.method === "round.readStop" ||
              m.method === "input.steer")
          ) {
            const principal: LocalActor = {
              id: actor.principal.id,
              environmentId: host.identity.id,
              allows: (permission, target) =>
                target.kind === "thread" && allows(target.threadId, permission),
            };
            result =
              (m.method === "input.steer"
                ? steerCommand?.(principal, m)
                : stopCommand?.(principal, m)) ?? null;
          }
          if (!result && m.method === "thread.changeLifecycle") {
            result = applyThreadChange(
              {
                actor: {
                  id: actor.principal.id,
                  environmentId: host.identity.id,
                  allows: (right, target) =>
                    target.kind === "thread" && allows(target.threadId, right),
                },
                commandId: m.commandId,
                transaction: store,
              },
              m.payload,
              visibility(),
            );
          }
          if (
            result?.kind === "accepted" &&
            (result.result.kind === "earlierSettled" || result.result.kind === "threadChanged")
          ) {
            const authorizedAt = visibility();
            const stream = sendLogicalRequest(peer, result);
            disclosures.set(m.commandId, { stream, allowed: () => authorizedAt === visibility() });
            wake();
            return;
          }
          if (!result && m.method === "thread.rename")
            result = renameThread({
              actor: {
                id: actor.principal.id,
                environmentId: host.identity.id,
                allows: () => allows(m.payload.threadId, "thread.send"),
              },
              commandId: m.commandId,
              transaction: store,
              ...m.payload,
            });
          if (
            !result &&
            session.features.includes("queueEditing") &&
            (m.method === "input.editQueued" ||
              m.method === "input.cancelQueued" ||
              m.method === "input.reorderQueue")
          )
            result = applyInputCommand({
              actor: {
                id: actor.principal.id,
                environmentId: host.identity.id,
                allows: (right) => allows(m.payload.threadId, right),
              },
              transaction: store,
              command: m,
            });
          if (!result && m.method === "input.send") {
            const permitted = allows(m.payload.threadId, "thread.send");
            const injected = permitted ? fixtureCommand?.(m, store) : null;
            if (injected) result = injected;
            else {
              void sendInput(
                {
                  id: actor.principal.id,
                  environmentId: host.identity.id,
                  allows: () => allows(m.payload.threadId, "thread.send"),
                },
                m,
              ).then(
                (receipt) => {
                  if (receipt.kind === "accepted") schedule(m.payload.threadId, m.commandId);
                  const deliver = () => {
                    if (session) {
                      peer.control(receipt);
                      wake();
                    }
                  };
                  if (beforeInputReceipt) beforeInputReceipt(m, receipt, deliver);
                  else deliver();
                },
                () => {
                  if (session) {
                    peer.control({
                      kind: "programError",
                      commandId: m.commandId,
                      code: "internalError",
                    });
                    wake();
                  }
                },
              );
              return;
            }
          }
          if (result?.kind === "accepted" && result.result.kind === "gitStatus") {
            const stream = sendLogicalRequest(peer, result);
            disclosures.set(m.commandId, {
              stream,
              allowed: () => m.method === "git.readStatus" && allowsWorkspace(m.payload.target),
            });
            return;
          }
          peer.control(
            result ?? {
              kind: "rejected",
              commandId: m.commandId,
              failure: { kind: "unsupported" },
            },
          );
        }
      }
      const version = host.store.db.query<{ data_version: number }, []>("PRAGMA data_version");
      let last = version.get()?.data_version,
        expires = Infinity;
      check = () => {
        if (!session) return;
        const next = version.get()?.data_version;
        for (const [id, d] of disclosures) {
          if (
            d.stream === undefined ? peer.send.pending.control === 0 : !peer.send.snapshot(d.stream)
          )
            disclosures.delete(id);
          else if (next !== last && !d.allowed()) throw Error("Todo read authority expired");
        }
        if (next === last && Date.now() < expires && expires !== Infinity) return;
        const device = usable(session.signer);
        if (!device || device.deviceKey.state.kind !== "usable")
          throw Error("Device registration ended");
        expires = device.deviceKey.state.expiresAt;
        if (next !== last) {
          subs?.recheckAccess();
          gitStatus?.recheckAccess();
        }
        last = next;
      };
      const timer = setInterval(wake, 250);
      timer.unref();
      peer.control(hello);
      return {
        control(m) {
          if (m.kind === "client.authenticate" || m.kind === "signedRequest") accept(m);
          else if (m.kind === "transport.content" && session && usable(session.signer))
            uploads.declare(m);
          else if (m.kind === "transport.probe" && session && usable(session.signer))
            peer.control({ kind: "transport.echo", serial: m.serial });
          else if (m.kind !== "stream.reset") throw Error("Unexpected thread control");
        },
        data(frame, size) {
          const req = uploads.data(frame, size, session?.features);
          if (req) accept(req);
        },
        discarded(id) {
          uploads.drop(id);
        },
        close() {
          stopWatching?.();
          session = null;
          clearInterval(timer);
          diffService.close();
          subs?.close();
          gitStatus?.close();
        },
      };
    },
  };
}
