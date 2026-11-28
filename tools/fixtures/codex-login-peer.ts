// Codex app-server v2 fixture, protocol revision bb5b9c6.
import { createInterface } from "node:readline";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
const args = process.argv.slice(2);
const methods = [
  "account/login/start",
  "account/login/cancel",
  "account/read",
  "model/list",
  "thread/start",
  "thread/read",
  "turn/start",
];
const notices = [
  "account/login/completed",
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
];
if (args[0] === "--version") {
  console.log("codex-cli 0.159.0");
  process.exit(0);
}
if (args[0] !== "app-server") throw Error("Expected app-server");
if (args[1] === "generate-json-schema" && args[2] === "--out" && args[3]) {
  for (const [file, names] of [
    ["ClientRequest", methods],
    ["ServerNotification", notices],
  ] as const)
    await writeFile(
      join(args[3], file + ".json"),
      JSON.stringify({
        oneOf: names.map((method) => ({ properties: { method: { const: method } } })),
      }),
    );
  process.exit(0);
}
const instance = v.parse(v.picklist(["A", "B"]), process.env.PEER_INSTANCE);
const control = v.parse(v.pipe(v.string(), v.url()), process.env.PEER_CONTROL);
const stop = new AbortController();
async function signal(method: string, body: object = {}) {
  const reply = await fetch(new URL(instance + "/" + method, control), {
    method: "POST",
    body: JSON.stringify(body),
    signal: stop.signal,
  });
  if (!reply.ok) throw Error("Control unavailable");
  return reply;
}
const write = (value: object) => process.stdout.write(JSON.stringify(value) + "\n");
await signal(
  process.env.SYNTHETIC_CODEX === "fixture-secret-" + instance ? "spawn.match" : "spawn.mismatch",
);
let initialized = false,
  handshake = false,
  loginId: string | null = null;
const callbacks: Promise<void>[] = [];
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const { method, params, id } = v.parse(
      v.object({
        method: v.string(),
        params: v.optional(v.record(v.string(), v.unknown()), {}),
        id: v.optional(v.number()),
      }),
      JSON.parse(line),
    );
    if (method === "initialize" && !handshake) {
      handshake = true;
      await signal(method);
      write({ id, result: { userAgent: "fixture", codexHome: process.env.CODEX_HOME } });
      continue;
    }
    if (method === "initialized" && handshake && !initialized) {
      initialized = true;
      await signal(method);
      continue;
    }
    if (!initialized || id === undefined) throw Error("Initialization required");
    const reply = await signal(method, {
      ...(method === "account/login/cancel" ? { matches: params.loginId === loginId } : {}),
    });
    if (method === "account/login/start") {
      const { expiresAt } = v.parse(
        v.object({ expiresAt: v.nullable(v.number()) }),
        await reply.json(),
      );
      loginId = crypto.randomUUID();
      const url = "https://example.invalid/challenge/fixture-private-" + instance + "-" + loginId;
      const data =
        params.type === "chatgpt"
          ? { type: "chatgpt", authUrl: url }
          : {
              type: "chatgptDeviceCode",
              verificationUrl: url,
              userCode: "fixture-code-" + instance + "-" + loginId,
            };
      write({ id, result: { ...data, loginId, ...(expiresAt !== null && { expiresAt }) } });
      const issued = loginId;
      callbacks.push(
        (async () => {
          const callback = await signal("awaitCallback", { loginId: issued });
          const { success } = v.parse(v.object({ success: v.boolean() }), await callback.json());
          write({
            method: "account/login/completed",
            params: { loginId: issued, success, error: null },
          });
          await signal("callbackSent", { loginId: issued });
        })().catch((e) => {
          if (!stop.signal.aborted) throw e;
        }),
      );
    } else if (method === "account/login/cancel")
      write({ id, result: { status: params.loginId === loginId ? "canceled" : "notFound" } });
    else if (method === "account/read") {
      if (params.refreshToken !== false) throw Error("Unexpected token refresh");
      const { account, fail } = v.parse(
        v.object({ account: v.nullable(v.string()), fail: v.boolean() }),
        await reply.json(),
      );
      write(
        fail
          ? { id, error: { code: -32603, message: "fixture private account failure" } }
          : {
              id,
              result: {
                account:
                  account === null ? null : { type: "chatgpt", email: account, planType: "plus" },
                requiresOpenaiAuth: true,
              },
            },
      );
    } else if (method === "model/list") {
      const { fail } = v.parse(v.object({ fail: v.boolean() }), await reply.json());
      write(
        fail
          ? { id, error: { code: -32603, message: "fixture private catalog failure" } }
          : {
              id,
              result: {
                data: ["first", "second"].map((name, i) => ({
                  id: instance + "-" + name,
                  model: instance + "-" + name,
                  displayName: name,
                  isDefault: i === 0,
                  supportedReasoningEfforts: [],
                })),
                nextCursor: null,
              },
            },
      );
    } else if (method === "thread/start") {
      write({
        id,
        result: {
          thread: { id: crypto.randomUUID(), cwd: params.cwd },
          cwd: params.cwd,
          model: params.model,
          approvalPolicy: params.approvalPolicy,
          approvalsReviewer: "user",
          sandbox: { type: "readOnly", networkAccess: false },
        },
      });
    } else write({ id, error: { code: -32601, message: "Unsupported fixture method" } });
  }
} finally {
  stop.abort();
  await Promise.allSettled(callbacks);
}
