import * as v from "valibot";
import {
  DeviceRegistrationSchema,
  EnvironmentIdentitySchema,
  ObjectVersionSchema,
  base64url,
} from "@kraka/protocol";
import { signP256 } from "@kraka/protocol/web-crypto";
import { listenIdentity } from "../../packages/daemon/src/identity";

const [id, publicDeviceKey, state] = process.argv.slice(2);
const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
  "sign",
  "verify",
]);
const identity = v.parse(EnvironmentIdentitySchema, {
  id,
  publicKey: base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey))),
  keyVersion: 1,
});
const device = v.parse(DeviceRegistrationSchema, {
  kind: "registered",
  identity,
  deviceId: "dev",
  keyId: "key",
  publicKey: publicDeviceKey,
  target: { kind: "project", projectId: "project" },
  principal: { kind: "device", id: "principal", ownerId: "owner", deviceId: "dev" },
  deviceKey: {
    id: "key",
    deviceId: "dev",
    publicKey: publicDeviceKey,
    state: { kind: "usable", expiresAt: state === "expired" ? 1 : Date.now() + 600000 },
  },
  permissions: ["thread.view"],
});
if (device.kind !== "registered") throw Error("Expected disposable registration");
const version = v.parse(ObjectVersionSchema, "1");
const server = listenIdentity({
  identity,
  sign: (text) => signP256(keys.privateKey, text),
  registration: () => device,
  configuration: { environment: { id: identity.id, version }, version, executors: [] },
  async request(_device, request) {
    if (request.method === "thread.readHistory" && request.payload.threadId === "T")
      return {
        kind: "accepted",
        commandId: request.commandId,
        result: { kind: "historyReadStarted", streamId: request.payload.streamId },
      };
    return { kind: "rejected", commandId: request.commandId, failure: { kind: "notFound" } };
  },
});
process.once("SIGTERM", () => {
  void server.close();
});
process.stdout.write(`${JSON.stringify({ origin: server.origin, identity })}\n`);
