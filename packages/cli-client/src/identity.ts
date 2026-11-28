import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  RouteIdSchema,
  type EnvironmentId,
  type EnvironmentIdentity,
  type Route,
} from "@kraka/protocol";
import { sameEnvironmentIdentity } from "@kraka/client-runtime";
import * as v from "valibot";
import { openDeviceCredentials, type LocalDevice } from "./pairing";
import { DeviceRouteDirectory } from "./routes";

export function clientDeviceFile() {
  return join(
    resolve(process.env.KRAKA_CLIENT_DIR ?? join(homedir(), ".kraka-client")),
    "device.sqlite",
  );
}

export async function verifiedIdentity(
  local: LocalDevice,
  directory: DeviceRouteDirectory,
  environmentId: EnvironmentId,
  endpoint: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const record = local.load(environmentId);
  if (record?.kind !== "registered")
    throw Error("CLI device is not registered for this environment");
  const url = new URL(endpoint);
  if (
    url.protocol !== "ws:" ||
    url.hostname !== "127.0.0.1" ||
    url.pathname !== "/ws" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw Error("Invalid local environment route");
  url.protocol = "http:";
  const route: Route = {
    id: v.parse(RouteIdSchema, environmentId + "-local"),
    environmentId,
    kind: "local",
    endpoint: url.origin,
    status: { kind: "untested" },
  };
  const saved = directory.load((catalog) => {
    const prior = catalog.environments.find((row) => row.environmentId === environmentId);
    if (prior?.pinnedIdentity && !sameEnvironmentIdentity(prior.pinnedIdentity, record.identity))
      throw Error("Pinned identity conflict");
    const row = {
      ...prior,
      environmentId,
      pinnedIdentity: record.identity,
      preferredRouteId: route.id,
      routes: [route, ...(prior?.routes ?? []).filter((r) => r.id !== route.id)],
    };
    return {
      ...catalog,
      environments: [...catalog.environments.filter((e) => e.environmentId !== environmentId), row],
    };
  });
  if (saved.kind !== "ready") throw Error("Cannot open CLI route catalog");
  const result = Promise.withResolvers<EnvironmentIdentity>();
  const connected = directory.connect(
    environmentId,
    {
      identity: record.identity,
      principal: record.principal,
      signer: { kind: "device", deviceId: local.deviceId, keyId: local.keyId },
      sign: local.sign,
    },
    (event) => {
      if (event.kind === "sender" && event.configuration.environment.id === environmentId)
        result.resolve(event.hello.identity);
      if (event.kind === "diagnostic" && event.diagnostic.detail.stage === "authentication")
        result.reject(Error(event.diagnostic.detail.reason));
      if (
        event.kind === "route" &&
        event.status.kind === "unavailable" &&
        saved.catalog.environments.find((e) => e.environmentId === environmentId)?.routes.length ===
          1
      )
        result.reject(Error("Environment unavailable: " + JSON.stringify(event.status.reason)));
    },
  );
  if (connected.kind !== "selecting") throw Error("Environment route unavailable");
  const abort = () => result.reject(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    return await result.promise;
  } finally {
    signal.removeEventListener("abort", abort);
    connected.selector.close();
  }
}

export async function identityCommand(
  environmentId: EnvironmentId,
  endpoint: string,
  signal: AbortSignal,
) {
  const file = clientDeviceFile(),
    device = await openDeviceCredentials(file);
  try {
    const directory = new DeviceRouteDirectory(join(dirname(file), "routes.sqlite"));
    try {
      const identity = await verifiedIdentity(device, directory, environmentId, endpoint, signal);
      return { environmentId: identity.id };
    } finally {
      directory.close();
    }
  } finally {
    device.close();
  }
}
