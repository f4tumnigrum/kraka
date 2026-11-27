import * as v from "valibot";
import {
  EnvironmentIdentitySchema,
  DevicePrincipalSchema,
  RequestSignerSchema,
  CommandReceiptSchema,
  GitStatusSchema,
  SubscriptionIdSchema,
} from "@kraka/protocol";
import { signP256 } from "@kraka/protocol/web-crypto";
import { connectGitClient } from "../../packages/cli-client/src/git-client";
import type { FixtureCredentials } from "./local-diff-browser";
import { Journal } from "./route-network";
import { terminate } from "./replay-process";
const open = v.object({
  url: v.string(),
  identity: EnvironmentIdentitySchema,
  principal: DevicePrincipalSchema,
  signer: RequestSignerSchema,
  privateKey: v.object({
    kty: v.string(),
    crv: v.string(),
    x: v.string(),
    y: v.string(),
    d: v.string(),
  }),
});
const message = v.variant("kind", [
  v.object({ kind: v.literal("ready") }),
  v.object({
    kind: v.literal("installed"),
    update: v.object({ subscriptionId: SubscriptionIdSchema, snapshot: GitStatusSchema }),
  }),
  v.object({ kind: v.literal("receipt"), id: v.string(), receipt: CommandReceiptSchema }),
]);
if (import.meta.main) {
  const input = v.parse(open, await Bun.stdin.json());
  const key = await crypto.subtle.importKey(
    "jwk",
    input.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const client = await connectGitClient(
    input.url,
    { ...input, sign: (s) => signP256(key, s) },
    (update) => process.send?.({ kind: "installed", update }),
  );
  process.on("message", async (raw) => {
    if (raw === "close") {
      client.close();
      process.disconnect?.();
      return;
    }
    const cmd = v.parse(
      v.object({ id: v.string(), method: v.string(), payload: v.unknown() }),
      raw,
    );
    process.send?.({
      kind: "receipt",
      id: cmd.id,
      receipt: await client.request(cmd.method, cmd.payload),
    });
  });
  process.send?.({ kind: "ready" });
}
export async function cliObserver(credentials: FixtureCredentials) {
  const events = new Journal<v.InferOutput<typeof message>>();
  const child = Bun.spawn([process.execPath, import.meta.path], {
    stdin: Buffer.from(JSON.stringify(credentials)),
    stdout: "ignore",
    stderr: "pipe",
    ipc: (raw) => events.push(v.parse(message, raw)),
  });
  const done = child.exited.then(async () => {
    throw Error(`Git CLI exited: ${await new Response(child.stderr).text()}`);
  });
  void done.catch(() => {});
  const until = (p: (event: v.InferOutput<typeof message>) => boolean) =>
    Promise.race([events.until(p), done]);
  try {
    await until((e) => e.kind === "ready");
    return {
      async request(method: string, payload: unknown) {
        const id = crypto.randomUUID();
        child.send({ id, method, payload });
        const reply = await until((e) => e.kind === "receipt" && e.id === id);
        if (reply.kind !== "receipt") throw Error("Missing CLI receipt");
        return reply.receipt;
      },
      async installed(match: (s: v.InferOutput<typeof GitStatusSchema>, id: string) => boolean) {
        const event = await until(
          (e) => e.kind === "installed" && match(e.update.snapshot, e.update.subscriptionId),
        );
        if (event.kind !== "installed") throw Error("Missing CLI observation");
        return event.update;
      },
      async close() {
        if (child.exitCode === null) child.send("close");
        await child.exited;
      },
    };
  } catch (e) {
    await terminate(child);
    throw e;
  }
}
