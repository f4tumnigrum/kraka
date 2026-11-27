import { join } from "node:path";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import { openAccessHost } from "../../packages/daemon/src/access";

const dir = process.argv[2];
if (!dir) throw Error("Expected disposable P1 state directory");
const host = await openAccessHost(join(dir, "host"), {
  present: async () => true,
  approve: async () => true,
});
try {
  const device = await openDeviceCredentials(join(dir, "client", "device.sqlite"));
  try {
    const result = await host.trusted.confirm({
      kind: "bootstrap",
      environment: host.identity,
      deviceId: device.deviceId,
      keyId: device.keyId,
      publicKey: device.publicKey,
    });
    const actor = host.store.device(device.deviceId);
    if (result !== "registered" || !actor) throw Error("P1 registration failed");
    console.log(JSON.stringify({ identity: host.identity, principal: actor.principal }));
  } finally {
    device.close();
  }
} finally {
  host.close();
}
