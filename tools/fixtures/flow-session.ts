import * as v from "valibot";
import {
  ServerHelloSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  SignedRequestSchema,
  TRANSPORT_LIMITS,
} from "@kraka/protocol";

export function fixtureSession(device: string, epoch: string, key = `fake-key-${device}`) {
  const principal = { kind: "device", id: "person-lee", ownerId: "person-lee", deviceId: device };
  const signer = { kind: "device", deviceId: device, keyId: key };
  const version = { major: 1, minor: 0 },
    features = ["perStreamFlowControl", "binaryContentChunks"];
  const hello = v.parse(ServerHelloSchema, {
    kind: "server.hello",
    connectionId: epoch,
    challengeId: `challenge-${epoch}`,
    challenge: "a".repeat(43),
    clientNonce: "b".repeat(43),
    protocolVersion: version,
    features,
    identity: { id: "studio", publicKey: "c".repeat(87), keyVersion: 1 },
    identityProof: "d".repeat(86),
  });
  const authorized = v.parse(SessionAuthorizedSchema, {
    kind: "session.authorized",
    connectionId: epoch,
    environmentId: "studio",
    environmentSessionId: `session-${epoch}`,
    principal,
    signer,
    authorizedAt: 1000,
    protocolVersion: version,
    features,
  });
  const configuration = v.parse(SessionConfigurationSchema, {
    kind: "session.configuration",
    connectionId: epoch,
    environmentSessionId: `session-${epoch}`,
    environment: { id: "studio", version: "1" },
    version: "1",
    executors: [],
    transportLimits: TRANSPORT_LIMITS,
  });
  let sequence = 10;
  const request = (method: string, payload: unknown) =>
    v.parse(SignedRequestSchema, {
      kind: "signedRequest",
      protocolVersion: version,
      environmentId: "studio",
      connectionId: epoch,
      challengeId: hello.challengeId,
      challenge: hello.challenge,
      signer,
      sequence: ++sequence,
      commandId: `${device}-${sequence}`,
      method,
      payload,
      signature: "e".repeat(86),
    });
  return { hello, authorized, configuration, request };
}
