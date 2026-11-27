import * as v from "valibot";
import {
  canonicalJson,
  decodeFrame,
  wireBytes,
  ClientAuthenticationSchema,
  SignedRequestSchema,
  SubscriptionIdSchema,
  type FlowPort,
  type WireMessage,
  type RegisteredDevice,
  type ProjectId,
  type SyncCursor,
} from "@kraka/protocol";
import { ThreadReplica } from "./thread-replica";
import { installedList } from "./thread-list";
import { type ThreadCache, type ThreadCacheStore } from "./thread-pass";

export type ListReading = NonNullable<ReturnType<typeof installedList>>;
export function listConnection(opts: {
  registration: Pick<RegisteredDevice, "identity" | "principal" | "deviceId" | "keyId">;
  nonce: string;
  projectId: ProjectId | null;
  cached: SyncCursor | null;
  verify: (key: string, text: string, signature: string) => Promise<boolean>;
  sign: (text: string) => Promise<string>;
  uuid: () => string;
  port: FlowPort;
  store: ThreadCacheStore;
  read: () => ThreadCache;
  installed: (reading: ListReading) => void;
  fail: (error: unknown) => void;
}) {
  const { registration, port } = opts;
  let replica: ThreadReplica | undefined,
    closed = false;
  let sub: Awaited<ReturnType<ThreadReplica["openList"]>>["sub"] | undefined;
  return {
    async input(wire: WireMessage) {
      try {
        if (closed) return;
        if (replica) {
          replica.peer.input(wire);
          replica.peer.pump();
          return;
        }
        const frame = decodeFrame(wire, port.utf8);
        if (frame.lane !== "control" || frame.message.kind !== "server.hello")
          throw Error("Expected signed hello");
        const hello = frame.message,
          { identityProof, ...body } = hello;
        if (
          body.clientNonce !== opts.nonce ||
          canonicalJson(body.identity) !== canonicalJson(registration.identity) ||
          !(await opts.verify(registration.identity.publicKey, canonicalJson(body), identityProof))
        )
          throw Error("Unverified list connection");
        if (closed) return;
        const signer = {
          kind: "device" as const,
          deviceId: registration.deviceId,
          keyId: registration.keyId,
        };
        const envelope = {
          protocolVersion: { major: 1, minor: 1 },
          environmentId: registration.identity.id,
          connectionId: hello.connectionId,
          challengeId: hello.challengeId,
          challenge: hello.challenge,
          signer,
        };
        const features = hello.features;
        const auth = {
          ...envelope,
          kind: "client.authenticate",
          method: "session.authenticate",
          clientNonce: opts.nonce,
          features,
          sequence: 1,
        };
        let sequence = 1;
        const r = new ThreadReplica(
          hello,
          {
            principal: registration.principal,
            signer,
            protocolVersion: envelope.protocolVersion,
            features,
          },
          port,
          {
            store: opts.store,
            read: opts.read,
            id: () => v.parse(SubscriptionIdSchema, opts.uuid()),
            async sign(method, payload) {
              const request = {
                ...envelope,
                kind: "signedRequest",
                method,
                payload,
                commandId: opts.uuid(),
                sequence: ++sequence,
              };
              return v.parse(SignedRequestSchema, {
                ...request,
                signature: await opts.sign(canonicalJson(request)),
              });
            },
            installed(head) {
              const reading = installedList(opts.read(), { status: "current", installed: head });
              if (!reading) throw Error("List installation incomplete");
              opts.installed(reading);
            },
          },
        );
        replica = r;
        void r.ready
          .then(async () => {
            const opened = await r.openList(opts.projectId, opts.cached);
            sub = opened.sub;
            const receipt = await opened.receipt;
            if (receipt.kind !== "accepted") throw Error("List subscription rejected");
          })
          .catch(opts.fail);
        r.authenticate(
          frame,
          wireBytes(wire, port.utf8),
          v.parse(ClientAuthenticationSchema, {
            ...auth,
            signature: await opts.sign(canonicalJson(auth)),
          }),
        );
      } catch (error) {
        opts.fail(error);
      }
    },
    reading() {
      return sub ? installedList(opts.read(), sub.state) : null;
    },
    close() {
      closed = true;
      replica?.close();
    },
  };
}
