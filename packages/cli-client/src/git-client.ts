import * as v from "valibot";
import {
  base64url,
  canonicalJson,
  decodeFrame,
  SignedRequestSchema,
  type CommandReceipt,
  type DiffRequest,
  type GitStatus,
  type SessionAuthorized,
  type ServerHello,
  type EnvironmentIdentity,
  type WireMessage,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import { SubscriptionSession, type GitStatusUpdate } from "@kraka/client-runtime";

export type GitClientIdentity = Pick<SessionAuthorized, "principal" | "signer"> & {
  identity: EnvironmentIdentity;
  sign(message: string): Promise<string>;
};
export async function connectGitClient(
  endpoint: string,
  device: GitClientIdentity,
  install: (update: GitStatusUpdate) => void,
  directoryDiff = true,
) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL("/ws", endpoint);
  url.searchParams.set("nonce", nonce);
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  const ready = Promise.withResolvers<void>();
  const timeout = setTimeout(() => fail(Error("Git handshake timed out")), 10000);
  let session: SubscriptionSession | undefined,
    hello: ServerHello | undefined,
    sequence = 0;
  const utf8 = {
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b),
  };
  function fail(err: Error) {
    clearTimeout(timeout);
    session?.close();
    ready.reject(err);
    socket.close();
  }
  let signing = Promise.resolve();
  async function request(method: string, payload: unknown): Promise<CommandReceipt> {
    const turn = signing.then(async () => {
      if (!hello || !session) throw Error("Git client disconnected");
      const body = {
        kind: "signedRequest",
        protocolVersion: hello.protocolVersion,
        environmentId: hello.identity.id,
        connectionId: hello.connectionId,
        challengeId: hello.challengeId,
        challenge: hello.challenge,
        signer: device.signer,
        sequence: sequence + 1,
        commandId: crypto.randomUUID(),
        method,
        payload,
      };
      const signed = v.parse(SignedRequestSchema, {
        ...body,
        signature: await device.sign(canonicalJson(body)),
      });
      if (
        signed.method === "checkpoint.diff" &&
        "directoryId" in signed.payload.query &&
        !(directoryDiff && hello.features.includes("directoryDiff"))
      )
        return {
          receipt: Promise.resolve({
            kind: "rejected",
            commandId: signed.commandId,
            failure: { kind: "unsupported" },
          } satisfies CommandReceipt),
        };
      sequence++;
      return { receipt: session.rpc(signed) };
    });
    signing = turn.then(
      () => {},
      () => {},
    );
    return (await turn).receipt;
  }
  async function status(
    payload: Extract<
      import("@kraka/protocol").SignedRequest,
      { method: "git.readStatus" }
    >["payload"],
  ): Promise<GitStatus> {
    const receipt = await request("git.readStatus", payload);
    if (receipt.kind !== "accepted" || receipt.result.kind !== "gitStatus")
      throw Error("Git status unavailable");
    return receipt.result.snapshot;
  }
  socket.onerror = () => fail(Error("Git socket failed"));
  socket.onclose = () => {
    session?.close();
    ready.reject(Error("Git socket closed"));
  };
  const receive = async (wire: WireMessage) => {
    if (!session) {
      const frame = decodeFrame(wire, utf8);
      if (frame.lane !== "control" || frame.message.kind !== "server.hello")
        throw Error("Expected Git server hello");
      hello = frame.message;
      const { identityProof, ...body } = hello;
      if (
        hello.clientNonce !== nonce ||
        canonicalJson(hello.identity) !== canonicalJson(device.identity) ||
        !(await verifyP256(device.identity.publicKey, canonicalJson(body), identityProof))
      )
        throw Error("Git server identity mismatch");
      const features = hello.features.filter((f) =>
        [
          "strictSchemas",
          "signedRequests",
          "perStreamFlowControl",
          "binaryContentChunks",
          "objectReplacementSync",
          ...(directoryDiff ? ["directoryDiff"] : []),
        ].includes(f),
      );
      const expected = {
        principal: device.principal,
        signer: device.signer,
        features,
        protocolVersion: hello.protocolVersion,
      };
      session = new SubscriptionSession(
        hello,
        expected,
        {
          utf8,
          now: () => performance.now(),
          write: (data) => {
            socket.send(data);
            return 1;
          },
        },
        () => {},
        undefined,
        install,
        ({ target, granularity }) => status({ target, granularity }),
      );
      session.peer.input(wire);
      const auth = {
        kind: "client.authenticate" as const,
        method: "session.authenticate" as const,
        protocolVersion: hello.protocolVersion,
        environmentId: hello.identity.id,
        connectionId: hello.connectionId,
        challengeId: hello.challengeId,
        challenge: hello.challenge,
        clientNonce: nonce,
        features,
        signer: device.signer,
        sequence: ++sequence,
      };
      session.peer.control({ ...auth, signature: await device.sign(canonicalJson(auth)) });
    } else session.peer.input(wire);
    session.peer.pump();
    if (session.snapshot(0).environment === "ready") {
      clearTimeout(timeout);
      ready.resolve();
    }
  };
  let incoming = Promise.resolve();
  socket.onmessage = (event) => {
    const wire = typeof event.data === "string" ? event.data : new Uint8Array(event.data);
    incoming = incoming.then(() => receive(wire)).catch((e) => fail(Error(String(e))));
  };
  await ready.promise;
  return {
    request,
    status,
    async diff(query: DiffRequest, cursor: string | null = null) {
      const r = await request("checkpoint.diff", { query, cursor });
      if (r.kind !== "accepted" || r.result.kind !== "checkpointDiff")
        throw Error(r.kind === "rejected" ? r.failure.kind : "Git diff unavailable");
      return r.result.diff;
    },
    close() {
      session?.close();
      socket.close();
    },
  };
}
