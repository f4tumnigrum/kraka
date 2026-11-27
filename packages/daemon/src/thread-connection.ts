import { createPublicKey, randomBytes, verify } from "node:crypto";
import * as v from "valibot";
import {
  canonicalJson,
  PAIRING_LIMITS,
  ConnectionIdSchema,
  ServerHelloSchema,
  SessionAuthorizedSchema,
  TRANSPORT_LIMITS,
  TOOL_ACTIVITY_DETAIL_MINOR,
  RequestUploads,
  type SubscriptionPage,
  type SessionAuthorized,
  type SignedRequest,
  type ClientAuthentication,
  type ThreadId,
  type CommandReceipt,
  type CommandId,
} from "@kraka/protocol";
import { type LocalActor, readThread, renameThread, type FirstSendStore } from "@kraka/environment";
import { ThreadSubscriptions } from "./thread-subscriptions";
import type { openAccessHost } from "./access";
import type { SocketApplication } from "./flow-socket";

export type FixtureThreadCommand = (
  request: SignedRequest,
  store: FirstSendStore,
) => CommandReceipt | null;
type Access = Awaited<ReturnType<typeof openAccessHost>>;
export async function threadConnection(
  store: FirstSendStore,
  host: Access,
  nonce: string,
  schedule: (threadId: ThreadId, commandId: CommandId) => void,
  sendInput: (
    actor: LocalActor,
    command: Extract<SignedRequest, { method: "input.send" }>,
  ) => Promise<CommandReceipt>,
  fixtureCommand?: FixtureThreadCommand,
  inspectPage?: (page: SubscriptionPage) => SubscriptionPage,
): Promise<SocketApplication | null> {
  if (host.identity.id !== store.writer.environmentId) return null;
  const epoch = v.parse(ConnectionIdSchema, crypto.randomUUID());
  const fields = {
    kind: "server.hello",
    connectionId: epoch,
    challengeId: crypto.randomUUID(),
    challenge: randomBytes(32).toString("base64url"),
    clientNonce: nonce,
    protocolVersion: { major: 1, minor: TOOL_ACTIVITY_DETAIL_MINOR },
    features: [
      "strictSchemas",
      "signedRequests",
      "objectReplacementSync",
      "perStreamFlowControl",
      "binaryContentChunks",
      "timelineItems",
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
      let seq = 0,
        session: SessionAuthorized | null = null,
        subs: ThreadSubscriptions | null = null;
      const uploads = new RequestUploads(peer);
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
      const allows = (threadId: ThreadId, permission: "thread.view" | "thread.send") => {
        if (!session || !usable(session.signer)) return false;
        const thread = readThread(store.db, threadId);
        if (!thread) return false;
        const bound = host.store.db
          .query<{ parent: string }, [string]>(
            "SELECT parent FROM objects WHERE kind='thread' AND id=?",
          )
          .get(threadId);
        if (bound && bound.parent !== thread.projectId) return false;
        if (!bound) {
          host.store.provisionProject(thread.projectId);
          host.store.provisionThread(threadId, thread.projectId);
        }
        return !!host.store.ceiling(session.principal.id, { kind: "thread", threadId }, permission);
      };
      function accept(m: SignedRequest | ClientAuthentication) {
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
              visibility: () => {
                const n = host.store.db
                  .query<{ n: string }, []>(
                    "SELECT CAST(COALESCE(MAX(rowid),0) AS TEXT) n FROM changes",
                  )
                  .get()?.n;
                return JSON.stringify([actor.principal.id, n]);
              },
              canRead: (id) => allows(id, "thread.view"),
              timelineItems: m.features.includes("timelineItems"),
              protocolMinor: m.protocolVersion.minor,
            },
            inspectPage,
          );
        } else {
          if (!session || !subs) throw Error("Configuration required");
          let result = subs.handle(m);
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
                  if (session) {
                    peer.control(receipt);
                    wake();
                  }
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
        if (next === last && Date.now() < expires && expires !== Infinity) return;
        const device = usable(session.signer);
        if (!device || device.deviceKey.state.kind !== "usable")
          throw Error("Device registration ended");
        expires = device.deviceKey.state.expiresAt;
        if (next !== last) subs?.recheckAccess();
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
          const req = uploads.data(frame, size);
          if (req) accept(req);
        },
        discarded(id) {
          uploads.drop(id);
        },
        close() {
          session = null;
          clearInterval(timer);
          subs?.close();
        },
      };
    },
  };
}
