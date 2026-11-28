import { Journal } from "./route-network";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { StoredRegistrationSchema } from "@kraka/protocol";
import * as v from "valibot";

export type Profile = "A" | "B";
function script() {
  return {
    account: null as string | null,
    expiresAt: null as number | null,
    accountFailure: false,
    catalogFailure: false,
    hold: null as ReturnType<typeof Promise.withResolvers<void>> | null,
    callback: Promise.withResolvers<boolean>(),
    observed: Promise.withResolvers<string>(),
    sent: Promise.withResolvers<string>(),
  };
}
export async function loginPeer(dir: string) {
  if (Bun.version !== "1.4.5") throw Error("Login fixture requires Bun 1.4.5");
  const binary = join(
    dir,
    process.platform === "win32" ? "codex-login-peer.exe" : "codex-login-peer",
  );
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "codex-login-peer.ts"),
      "--outfile",
      binary,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [exit, error] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (exit !== 0) throw Error(error);
  const profiles = { A: script(), B: script() };
  const ledger = new Journal<{ method: string; instance: Profile; at: number }>();
  let time = 1710000000000;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const parts = new URL(req.url).pathname.split("/");
      const instance = v.parse(v.picklist(["A", "B"]), parts[1]);
      const method = parts.slice(2).join("/");
      const p = profiles[instance];
      ledger.push({ instance, method, at: time });
      switch (method) {
        case "account/login/start":
          return Response.json({ expiresAt: p.expiresAt });
        case "account/login/cancel": {
          const { matches } = v.parse(v.object({ matches: v.boolean() }), await req.json());
          if (!matches) ledger.push({ instance, method: "cancel.mismatch", at: time });
          return new Response(null, { status: 204 });
        }
        case "awaitCallback": {
          const { loginId } = v.parse(v.object({ loginId: v.string() }), await req.json());
          p.observed.resolve(loginId);
          return Response.json({ success: await p.callback.promise });
        }
        case "callbackSent": {
          const { loginId } = v.parse(v.object({ loginId: v.string() }), await req.json());
          p.sent.resolve(loginId);
          return new Response(null, { status: 204 });
        }
        case "account/read":
          if (p.hold) {
            ledger.push({ instance, method: "accountReadHeld", at: time });
            await p.hold.promise;
          }
          return Response.json({ account: p.account, fail: p.accountFailure });
        case "model/list":
          return Response.json({ fail: p.catalogFailure });
        default:
          return new Response(null, { status: 204 });
      }
    },
  });
  async function profile(id: Profile, ownerId = "fixture-owner-" + id) {
    const root = join(dir, id),
      history = join(root, "history");
    await mkdir(history, { recursive: true });
    const marker = "fixture-secret-" + id;
    const credential = {
      ownerId,
      namespace: id,
      key: "profile",
      version: "1",
    };
    const reg = v.parse(StoredRegistrationSchema, {
      family: "codex",
      instanceId: id,
      displayName: id,
      version: "1",
      enabled: true,
      driver: {
        executable: binary,
        endpoint: null,
        configurationRoot: root,
        historyRoot: history,
        variables: {
          SYNTHETIC_CODEX: { kind: "secret", binding: credential },
          PEER_CONTROL: { kind: "literal", value: server.url.href },
          PEER_INSTANCE: { kind: "literal", value: id },
        },
      },
      credential,
      model: null,
      permission: { ceiling: "ask", selected: "ask" },
    });
    return {
      reg,
      launch: {
        executable: binary,
        cwd: dir,
        env: {
          PEER_CONTROL: server.url.href,
          PEER_INSTANCE: id,
          SYNTHETIC_CODEX: marker,
          CODEX_HOME: root,
        },
      },
    };
  }
  function release() {
    for (const p of Object.values(profiles)) {
      p.callback.resolve(false);
      p.hold?.resolve();
    }
  }
  return {
    profiles,
    profile,
    ledger,
    now: () => time,
    setTime: (t: number) => (time = t),
    release,
    async close() {
      release();
      await server.stop(true);
    },
  };
}
