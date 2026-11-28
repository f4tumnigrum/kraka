import { parseArgs } from "node:util";
import { listenBrowserDaemon } from "../browser-daemon";
export async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      listen: { type: "string" },
      port: { type: "string" },
      "tls-cert": { type: "string" },
      "tls-key": { type: "string" },
      "public-origin": { type: "string" },
    },
  });
  if (!values["state-dir"] || !values.listen || !values.port || !/^\d+$/.test(values.port))
    throw new Error("Expected daemon --state-dir DIR --listen 127.0.0.1 --port N");
  const listener = await listenBrowserDaemon(values["state-dir"], {
    host: values.listen,
    port: Number(values.port),
    ...(values["tls-cert"] !== undefined ? { certificate: values["tls-cert"] } : {}),
    ...(values["tls-key"] !== undefined ? { privateKey: values["tls-key"] } : {}),
    ...(values["public-origin"] !== undefined ? { publicOrigin: values["public-origin"] } : {}),
  });
  process.once("SIGTERM", listener.shutdown);
  process.once("SIGINT", listener.shutdown);
  process.stdout.write(`${JSON.stringify(listener.ready)}\n`);
}
