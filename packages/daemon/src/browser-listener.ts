import { X509Certificate, createPrivateKey } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { checkListener } from "@kraka/environment";
import { canonicalHttpOrigin } from "@kraka/protocol";

export interface BrowserListenerOptions {
  host: string;
  port: number;
  publicOrigin?: string;
  certificate?: string;
  privateKey?: string;
}
async function material<T>(file: string | undefined, parse: (bytes: Buffer) => T) {
  if (file === undefined) return null;
  try {
    const bytes = await readFile(file);
    return { bytes, parsed: parse(bytes) };
  } catch {
    return null;
  }
}
export async function preflight(options: BrowserListenerOptions) {
  const bindName = options.host.replace(/^\[|\]$/g, "");
  const ip = isIP(bindName);
  const loopback =
    bindName === "localhost" ||
    (ip === 4 && bindName.startsWith("127.")) ||
    (ip === 6 && new URL("http://[" + bindName + "]").hostname === "[::1]");
  const origin =
    options.publicOrigin === undefined ? null : canonicalHttpOrigin(options.publicOrigin, URL);
  const hostname = (origin ? new URL(origin).hostname : bindName).replace(/^\[|\]$/g, "");
  const [cert, key] = await Promise.all([
    material(options.certificate, (b) => new X509Certificate(b)),
    material(options.privateKey, (b) => createPrivateKey(b)),
  ]);
  const checked = checkListener(
    {
      bind: { kind: loopback ? "loopback" : "external", hostname: bindName },
      publishedOrigin: options.publicOrigin ?? null,
      certificateConfigured: options.certificate !== undefined,
      privateKeyConfigured: options.privateKey !== undefined,
      tls: {
        certificateReadable: !!cert,
        keyReadable: !!key,
        keyMatches: !!(key && cert?.parsed.checkPrivateKey(key.parsed)),
        coversPublishedHost: !!(isIP(hostname)
          ? cert?.parsed.checkIP(hostname)
          : cert?.parsed.checkHost(hostname, { subject: "never" })),
      },
    },
    URL,
  );
  if (checked.kind === "failed") throw Error(JSON.stringify(checked));
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535)
    throw Error("Invalid listen port");
  return {
    host: bindName,
    port: options.port,
    publishedHost: checked.hostname,
    protocol: checked.protocol,
    ...(cert && key ? { tls: { cert: cert.bytes, key: key.bytes } } : {}),
  };
}
declare const KRAKA_BROWSER_JS: string;
export async function browserAssets() {
  if (typeof KRAKA_BROWSER_JS !== "undefined") return KRAKA_BROWSER_JS;
  const entry = new URL("../../browser-host/src/index.ts", import.meta.url);
  const built = await Bun.build({
    entrypoints: [Bun.fileURLToPath(entry)],
    target: "browser",
    minify: { whitespace: true },
  });
  if (!built.success || !built.outputs[0]) throw Error("Browser bundle build failed");
  return built.outputs[0].text();
}
const page =
  '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Kraka</title><main><h1>Kraka</h1><output id="status">Opening</output></main><script type="module">import {startBrowserPage} from "/assets/browser-host.js"; startBrowserPage(document.querySelector("main"));</script></html>';
export function browserPage() {
  return page;
}
