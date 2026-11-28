import { join } from "node:path";
import * as v from "valibot";
import type { GitHubConfig } from "@kraka/environment";
import { certificate } from "./browser-cert";

export type FixtureAccount = { id: number; login: string; credential: string };
const invocation = v.strictObject({ argv: v.array(v.string()), overrides: v.array(v.string()) });
type Helper = { kind: "helper" } & v.InferOutput<typeof invocation>;
type Api = {
  kind: "api";
  host: string;
  path: string;
  method: string;
  matched: boolean;
  version: string | null;
};
export const ghVersion = "2.80.0";
export async function startForgeFixture({
  root,
  routes,
  accounts,
}: {
  root: string;
  accounts: Record<string, FixtureAccount>;
  routes: (call: Api, requestBody: unknown) => Response | undefined | Promise<Response | undefined>;
}) {
  const ledger: (Helper | Api)[] = [];
  const tls = await certificate(root);
  const origins = new Map<string, string>();
  const servers: Bun.Server<undefined>[] = [];
  const config: GitHubConfig = { gh: ["gh"], hosts: [] };
  async function close() {
    await Promise.all(servers.splice(0).map((server) => server.stop(true)));
  }
  try {
    const control = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const call = v.parse(invocation, await request.json());
        ledger.push({ kind: "helper", ...call });
        const [a, b, c, host] = call.argv;
        if (a === "--version" && call.argv.length === 1)
          return new Response("gh version " + ghVersion + "\n");
        const account = host && accounts[host];
        if (
          a !== "auth" ||
          b !== "token" ||
          c !== "--hostname" ||
          !account ||
          call.argv.length !== 4
        )
          return new Response(null, { status: 400 });
        return new Response(account.credential + "\n");
      },
    });
    servers.push(control);
    config.gh = [process.execPath, join(import.meta.dir, "forge-gh.ts"), control.url.href];
    for (const host of Object.keys(accounts)) {
      const peer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        tls: { cert: Bun.file(tls.cert), key: Bun.file(tls.key) },
        async fetch(request) {
          const url = new URL(request.url);
          const account = accounts[host];
          const matched =
            !!account?.credential &&
            request.headers.get("authorization") === "Bearer " + account.credential;
          const call: Api = {
            kind: "api",
            host,
            path: url.pathname + url.search,
            method: request.method,
            matched,
            version: request.headers.get("x-github-api-version"),
          };
          ledger.push(call);
          if (!matched || !account) return new Response(null, { status: 401 });
          const result = await routes(call, request.body ? await request.json() : null);
          if (result) return result;
          return call.path === "/user"
            ? Response.json({ id: account.id, login: account.login })
            : new Response(null, { status: 404 });
        },
      });
      servers.push(peer);
      origins.set(host, peer.url.origin);
      config.hosts.push({ host, api: peer.url.origin, apiVersion: "2026-03-10", caFile: tls.cert });
    }
    return { origins, gh: config.gh, ca: tls.ca, config, ledger, close };
  } catch (error) {
    await close();
    throw error;
  }
}
