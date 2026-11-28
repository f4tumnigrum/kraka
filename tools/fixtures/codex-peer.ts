import { controlledTurn } from "./codex-controlled";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import * as v from "valibot";

const profile = process.env.PEER_PROFILE ?? "ready",
  ledger = process.env.PEER_LEDGER ?? "peer.log",
  recording = process.env.PEER_RECORDING ?? "frames";
const ledgerPath = ledger;
const args = process.argv.slice(2);
const handle = process.pid;
function log(event: string, id: string | number | null, details: Record<string, unknown> = {}) {
  appendFileSync(ledgerPath, `${JSON.stringify({ handle, event, id, ...details })}\n`);
}
if (args[0] === "--version") {
  log("version", null);
  console.log(`codex-cli ${process.env.PEER_VERSION ?? "0.156.0"}`);
  process.exit(0);
}
if (
  args[0] === "app-server" &&
  args[1] === "generate-json-schema" &&
  args[2] === "--out" &&
  args[3]
) {
  log("protocolSchema", null);
  const frames = readFileSync(recording, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  if (process.env.PEER_CONTROL)
    writeFileSync(
      join(args[3], "ServerRequest.json"),
      JSON.stringify({
        oneOf: [
          "item/commandExecution/requestApproval",
          "item/fileChange/requestApproval",
          "item/tool/requestUserInput",
        ].map((method) => ({ properties: { method: { const: method } } })),
      }),
    );
  for (const [file, direction] of [
    ["ClientRequest.json", "toExecutor"],
    ["ServerNotification.json", "fromExecutor"],
  ] as const) {
    const methods = new Set<string>(
      frames
        .filter((r) => r.direction === direction && typeof r.frame.method === "string")
        .map((r) => r.frame.method),
    );
    if (direction === "toExecutor") {
      methods.add("thread/read");
      methods.add("thread/resume");
      if (process.env.PEER_CONTROL) {
        methods.add("turn/interrupt");
        methods.add("turn/steer");
      }
    }
    writeFileSync(
      join(args[3], file),
      JSON.stringify({
        oneOf: [...methods].map((method) => ({
          properties: {
            method: { enum: [method] },
            ...(method === "turn/steer"
              ? {
                  params: {
                    properties: {
                      threadId: { type: "string" },
                      expectedTurnId: { type: "string" },
                      input: {
                        type: "array",
                        items: {
                          oneOf: [
                            { properties: { type: { const: "text" }, text: { type: "string" } } },
                          ],
                        },
                      },
                    },
                  },
                }
              : {}),
          },
        })),
      }),
    );
  }
  process.exit(0);
}
if (args.join() !== "app-server") throw new Error("Unexpected fixture command");
const frameSchema = v.object({
  kind: v.literal("frame"),
  seq: v.number(),
  frame: v.record(v.string(), v.unknown()),
});
const frames = new Map<number, Record<string, unknown>>();
for (const line of readFileSync(recording, "utf8").trim().split("\n")) {
  const r = v.safeParse(frameSchema, JSON.parse(line));
  if (r.success) frames.set(r.output.seq, r.output.frame);
}
function obj(raw: unknown) {
  return v.parse(v.record(v.string(), v.unknown()), raw);
}
function frame(n: number) {
  const f = frames.get(n);
  if (!f) throw new Error("Missing recording frame");
  return f;
}
function write(f: unknown) {
  process.stdout.write(`${JSON.stringify(f)}\n`);
}
let initialized = false,
  handshake = false,
  session: string | null = null,
  openedModel: unknown = null,
  startId: number | null = null,
  next = 1;
log("spawn", null, {
  present: process.env.SYNTHETIC_CODEX === "fake-private-marker",
  cwd: process.cwd(),
});
async function signal(event: string) {
  const url = process.env.PEER_SIGNALS;
  if (!url) return;
  const reply = await fetch(new URL(event, url));
  if (!reply.ok) throw Error("Peer signal failed: " + event);
}
async function gate(name: string, id: number | null) {
  if (process.env.PEER_GATE !== name) return;
  log(`gate.${name}`, id);
  await signal("gate." + name);
}
const controlled = process.env.PEER_CONTROL
  ? controlledTurn(process.env.PEER_CONTROL, recording, write)
  : null;
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const r = obj(JSON.parse(line));
  if (!r.method) {
    if (controlled) await controlled.reply(r);
    continue;
  }
  const method = String(r.method),
    id = typeof r.id === "number" ? r.id : null;
  const p = r.params ? obj(r.params) : {};
  if (id !== null && id !== next++) throw new Error("Host request IDs out of sequence");
  log(
    method,
    id,
    method === "turn/start"
      ? { hasInput: Array.isArray(p.input), clientId: p.clientUserMessageId }
      : method === "model/list"
        ? { cursor: p.cursor }
        : {},
  );
  if (method === "initialize") {
    if (handshake || id !== 1) throw new Error("Unexpected initialize");
    write({ id, result: frame(2).result });
    handshake = true;
    await signal("initialize");
    continue;
  }
  if (method === "initialized") {
    if (!handshake || initialized || id !== null) throw new Error("Invalid initialized");
    initialized = true;
    await signal("initialized");
    continue;
  }
  if (!initialized || id === null) throw new Error("RPC before initialized");
  if (method === "account/read") {
    await gate("account", id);
    if (p.refreshToken !== false) throw new Error("Interactive refresh");
    write({
      id,
      result: {
        account: profile === "logged-out" ? null : { type: "apiKey", name: "synthetic account" },
        requiresOpenaiAuth: true,
      },
    });
  } else if (method === "model/list") {
    const slug = p.cursor === null ? "gpt-5.4" : "other";
    if (p.cursor !== null && p.cursor !== "p2") throw new Error("Invalid model cursor");
    write({
      id,
      result: {
        data: [
          {
            id: slug,
            model: slug,
            displayName: slug,
            isDefault: p.cursor === null,
            supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
            supportedServiceTiers: ["default"],
          },
        ],
        nextCursor: p.cursor === null ? "p2" : null,
      },
    });
  } else if (method === "thread/start" || method === "thread/resume") {
    const result = obj(frame(5).result);
    const thread = obj(result.thread);
    const cwd = process.cwd(),
      model = p.model;
    if (
      p.cwd !== cwd ||
      !["gpt-5.4", "other"].includes(String(model)) ||
      (!controlled && p.approvalPolicy !== "untrusted") ||
      p.approvalsReviewer !== "user" ||
      (!controlled && p.sandbox !== "read-only")
    )
      throw new Error("Unexpected submitted open policy");
    session = String(thread.id);
    if (controlled && !p.ephemeral) session = await controlled.open(method, p);
    if (!controlled && method === "thread/resume" && p.threadId !== session)
      throw Error("Wrong saved session");
    openedModel = model;
    const actual = profile === "mismatch" && !p.ephemeral ? "never" : p.approvalPolicy;
    if (actual === "never") await gate("policy", id);
    log("policy", id, {
      model,
      cwd,
      approvalPolicy: actual,
      sandbox: "read-only",
      reviewer: "user",
      probe: !!p.ephemeral,
      session,
    });
    write({
      id,
      result: {
        ...result,
        thread: { ...thread, id: session, cwd, model },
        ...(controlled
          ? {
              sandbox:
                p.sandbox === "workspace-write"
                  ? {
                      type: "workspaceWrite",
                      writableRoots: [cwd],
                      networkAccess: false,
                      excludeSlashTmp: true,
                      excludeTmpdirEnvVar: true,
                    }
                  : p.sandbox === "danger-full-access"
                    ? { type: "dangerFullAccess" }
                    : result.sandbox,
            }
          : {}),
        cwd,
        model,
        approvalPolicy: actual,
        reasoningEffort: p.config ? obj(p.config).model_reasoning_effort : null,
        serviceTier: p.serviceTier ?? null,
      },
    });
  } else if (controlled && session) {
    await controlled.request(method, id, p);
  } else if (method === "turn/start") {
    if (!p.threadId) {
      write({ id, error: { code: -32602, message: "Missing required threadId" } });
      continue;
    }
    startId = id;
    if (
      session !== p.threadId ||
      typeof p.clientUserMessageId !== "string" ||
      !Bun.deepEquals(p.input, obj(frame(7).params).input)
    )
      throw new Error("Unexpected frozen input");
    if (profile === "denied" && openedModel !== "other") {
      write({
        id,
        error: {
          code: -32000,
          message: `Model unavailable for this account: ${process.env.SYNTHETIC_CODEX}`,
          data: { codexErrorInfo: "unauthorized" },
        },
      });
      continue;
    }
    const order =
      profile === "early"
        ? [9, 10, 8, 11, 12, 13, 14, 15, 16, 17, 18, 19]
        : Array.from({ length: 12 }, (_, i) => i + 8);
    for (const seq of order) {
      if (process.env.PEER_FRAME_GATE && [12, 13, 14, 16, 19].includes(seq)) {
        const reply = await fetch(new URL(String(seq), process.env.PEER_FRAME_GATE));
        if (!reply.ok) throw Error("Recorded frame gate closed");
      }
      await gate(String(seq), id);
      if (seq === 9) log("root", id, { session });
      if (seq === 19 && profile === "history") {
        const end = frame(seq),
          params = obj(end.params);
        write({ ...end, params: { ...params, turn: { ...obj(params.turn), completedAt: null } } });
      } else write(seq === 8 ? { id, result: frame(seq).result } : frame(seq));
    }
  } else if (method === "thread/read") {
    if (startId === null || p.threadId !== session) throw new Error("Foreign history lookup");
    write({ id, result: { thread: { id: session, turns: [obj(frame(19).params).turn] } } });
  } else write({ id, error: { code: -32601, message: "Method not found" } });
}
controlled?.close();
log("exit", null);
