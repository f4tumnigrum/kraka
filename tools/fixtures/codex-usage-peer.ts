import { createInterface } from "node:readline";
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
const args = process.argv.slice(2);
const account = process.env.S42_ACCOUNT,
  control = process.env.S42_CONTROL,
  nativeHome = process.env.CODEX_HOME;
if (!account || !control || !nativeHome || new URL(control).hostname !== "127.0.0.1")
  throw Error("Missing case-local peer settings");
if (args[0] === "--version") {
  console.log("codex-cli 0.159.0");
  process.exit(0);
}
const requests = [
  "thread/start",
  "thread/resume",
  "thread/read",
  "turn/start",
  "account/rateLimits/read",
  "account/usage/read",
];
const notices = [
  "turn/started",
  "turn/completed",
  "item/started",
  "item/completed",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "thread/tokenUsage/updated",
];
if (args[1] === "generate-json-schema" && args[2] === "--out" && args[3]) {
  for (const [file, list] of [
    ["ClientRequest", requests],
    ["ServerNotification", notices],
  ] as const)
    await Bun.write(
      join(args[3], file + ".json"),
      JSON.stringify({
        oneOf: list.map((method) => ({ properties: { method: { const: method } } })),
      }),
    );
  process.exit(0);
}
if (args.join(" ") !== "app-server") throw Error("Unexpected peer arguments");
const write = (frame: unknown) => process.stdout.write(JSON.stringify(frame) + "\n");
const rpc = v.object({
  id: v.optional(v.number()),
  method: v.string(),
  params: v.optional(v.record(v.string(), v.unknown())),
});
const controlReply = v.object({
  result: v.optional(v.unknown()),
  error: v.optional(v.unknown()),
  notices: v.optional(v.array(v.object({ method: v.string(), params: v.unknown() }))),
});
let initialized = false,
  ready = false,
  session: string | null = null;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const { method, id, params = {} } = v.parse(rpc, JSON.parse(line));
  if (method === "initialize" && !initialized) {
    initialized = true;
    write({ id, result: { userAgent: "synthetic/bb5b9c6", codexHome: nativeHome } });
    continue;
  }
  if (method === "initialized" && initialized && !ready) {
    ready = true;
    continue;
  }
  if (!ready || id === undefined) throw Error("Expected initialized handshake");
  if (method === "account/read") {
    if (params.refreshToken !== false) throw Error("Unexpected token refresh");
    write({
      id,
      result: {
        account: {
          type: "chatgpt",
          email: account + "@example.invalid",
          planType: "plus",
          workspaceName: null,
        },
        userId: account,
        requiresOpenaiAuth: true,
      },
    });
  } else if (method === "model/list") {
    write({
      id,
      result: {
        data: [
          {
            id: "fixture",
            model: "fixture",
            displayName: "Synthetic model",
            isDefault: true,
            supportedReasoningEfforts: [],
          },
        ],
        nextCursor: null,
      },
    });
  } else if (method === "thread/start" || method === "thread/resume") {
    session =
      method === "thread/resume" ? v.parse(v.string(), params.threadId) : crypto.randomUUID();
    write({
      id,
      result: {
        thread: {
          id: session,
          cwd: params.cwd,
          model: params.model,
          path: join(nativeHome, session + ".jsonl"),
        },
        cwd: params.cwd,
        model: params.model,
        approvalPolicy: params.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: { type: "readOnly", networkAccess: false },
      },
    });
  } else {
    if (
      (method === "turn/start" || method === "account/usage/read") &&
      (!session || params.threadId !== session)
    )
      throw Error("Wrong native thread");
    const reply = await fetch(control, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account, method, id, session, params }),
    });
    if (!reply.ok) throw Error("Case controller unavailable");
    const message = v.parse(controlReply, await reply.json());
    if (method === "turn/start" && session && process.env.S42_HISTORY === "1") {
      const path = join(nativeHome, session + ".jsonl");
      if (!(await Bun.file(path).exists()))
        await appendFile(
          path,
          JSON.stringify({ type: "session_meta", payload: { id: session } }) + "\n",
        );
      for (const notice of message.notices ?? []) {
        if (notice.method !== "thread/tokenUsage/updated") continue;
        const p = v.parse(
          v.object({
            turnId: v.string(),
            tokenUsage: v.object({
              last: v.record(v.string(), v.number()),
              total: v.record(v.string(), v.number()),
            }),
          }),
          notice.params,
        );
        const convert = (t: Record<string, number>) => ({
          input_tokens: t.inputTokens,
          cached_input_tokens: t.cachedInputTokens,
          output_tokens: t.outputTokens,
          reasoning_output_tokens: t.reasoningOutputTokens,
          total_tokens: t.totalTokens,
        });
        await appendFile(
          path,
          [
            { type: "turn_context", payload: { turn_id: p.turnId } },
            {
              type: "event_msg",
              payload: {
                type: "token_count",
                info: {
                  last_token_usage: convert(p.tokenUsage.last),
                  total_token_usage: convert(p.tokenUsage.total),
                },
              },
            },
          ]
            .map((x) => JSON.stringify(x) + "\n")
            .join(""),
        );
      }
    }
    write(message.error ? { id, error: message.error } : { id, result: message.result });
    let seenUsage = false;
    for (const notice of message.notices ?? []) {
      if (
        seenUsage &&
        notice.method === "thread/tokenUsage/updated" &&
        process.env.S42_HISTORY === "1"
      ) {
        const gate = await fetch(control, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ account, method: "fixture/repeatUsage", session, params: {} }),
        });
        if (!gate.ok) throw Error("Usage barrier failed");
      }
      write(notice);
      seenUsage ||= notice.method === "thread/tokenUsage/updated";
    }
  }
}
