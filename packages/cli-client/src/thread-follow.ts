import { dirname, join } from "node:path";
import * as v from "valibot";
import { canonicalJson, RouteIdSchema, type EnvironmentId, type ThreadId } from "@kraka/protocol";
import { observeNativeThread } from "@kraka/client-runtime/native-thread";
import { clientDeviceFile } from "./identity";
import { openDeviceCredentials } from "./pairing";
import { SqliteThreadCache } from "./thread-cache";

export async function followThread(
  environmentId: EnvironmentId,
  endpoint: string,
  threadId: ThreadId,
  signal: AbortSignal,
) {
  const file = clientDeviceFile(),
    device = await openDeviceCredentials(file);
  try {
    const registration = device.load(environmentId);
    if (registration?.kind !== "registered")
      throw Error("CLI device is not registered for this environment");
    const origin = new URL(endpoint);
    if (origin.protocol !== "ws:" || origin.hostname !== "127.0.0.1" || origin.pathname !== "/ws")
      throw Error("Invalid foreground publication");
    origin.protocol = "http:";
    const store = new SqliteThreadCache(
      join(dirname(file), "threads.sqlite"),
      canonicalJson([environmentId, registration.principal.id, threadId]),
    );
    try {
      const end = Promise.withResolvers<void>();
      const close = () => end.resolve();
      signal.addEventListener("abort", close, { once: true });
      const client = observeNativeThread({
        registration,
        sign: device.sign,
        store,
        threadId,
        route: {
          id: v.parse(RouteIdSchema, environmentId + "-local"),
          kind: "local",
          environmentId,
          endpoint: origin.origin,
          status: { kind: "untested" },
        },
        installed: (r) => process.stdout.write(JSON.stringify(r) + "\n"),
        failed: end.reject,
      });
      try {
        if (!signal.aborted) await end.promise;
      } finally {
        client.close();
        signal.removeEventListener("abort", close);
      }
    } finally {
      store.close();
    }
  } finally {
    device.close();
  }
}
