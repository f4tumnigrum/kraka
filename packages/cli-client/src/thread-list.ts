import { join } from "node:path";
import { parseArgs } from "node:util";
import * as v from "valibot";
import { base64url, canonicalJson, EnvironmentIdSchema, ProjectIdSchema } from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import { listConnection, type ListReading } from "@kraka/client-runtime";
import { openDeviceCredentials } from "./pairing";
import { SqliteThreadCache } from "./thread-cache";

export async function threadListCli(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      json: { type: "boolean" },
      environment: { type: "string" },
      endpoint: { type: "string" },
      "device-dir": { type: "string" },
      project: { type: "string" },
    },
  });
  const dir = values["device-dir"] ?? process.env.KRAKA_DEVICE_DIR,
    endpoint = values.endpoint ?? process.env.KRAKA_ENDPOINT;
  const environment = values.environment ?? process.env.KRAKA_ENVIRONMENT;
  if (!dir || !endpoint || !environment || !values.json)
    throw Error(
      "Expected thread list --json with a selected device directory, endpoint and environment",
    );
  const device = await openDeviceCredentials(join(dir, "device.sqlite"));
  try {
    const reg = device.load(v.parse(EnvironmentIdSchema, environment));
    if (reg?.kind !== "registered") throw Error("Device is not registered in this environment");
    const projectId = values.project ? v.parse(ProjectIdSchema, values.project) : null;
    const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
    const url = new URL(endpoint);
    url.pathname = "/ws";
    url.search = new URLSearchParams({ nonce }).toString();
    const cache = new SqliteThreadCache(
      join(dir, "lists.sqlite"),
      canonicalJson([reg.identity.id, reg.principal.id]),
    );
    try {
      const result = Promise.withResolvers<ListReading>(),
        socket = new WebSocket(url);
      socket.binaryType = "arraybuffer";
      const encoder = new TextEncoder(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      const cached =
        cache.read().scopes[canonicalJson({ kind: "list", projectId })]?.cursor ?? null;
      const client = listConnection({
        registration: reg,
        cached,
        projectId,
        nonce,
        verify: verifyP256,
        sign: device.sign,
        uuid: () => crypto.randomUUID(),
        store: cache,
        read: () => cache.read(),
        installed: result.resolve,
        fail: result.reject,
        port: {
          utf8: { encode: (s) => encoder.encode(s), decode: (b) => decoder.decode(b) },
          now: () => performance.now(),
          write: (data) => {
            socket.send(data);
            return 1;
          },
        },
      });
      socket.onmessage = ({ data }) =>
        void client.input(typeof data === "string" ? data : new Uint8Array(data as ArrayBuffer));
      socket.onerror = () => result.reject(Error("List connection failed"));
      socket.onclose = () => result.reject(Error("List connection closed"));
      const timer = setTimeout(() => result.reject(Error("List installation timed out")), 30000);
      try {
        console.log(JSON.stringify(await result.promise));
      } finally {
        clearTimeout(timer);
        client.close();
        socket.close();
      }
    } finally {
      cache.close();
    }
  } finally {
    device.close();
  }
}
