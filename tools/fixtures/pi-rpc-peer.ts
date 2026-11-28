import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { join, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import { closePeerOutput } from "./pi-peer-output";
import errorRecording from "../../fixtures/executors/pi/error.jsonl" with { type: "text" };

const args = process.argv.slice(2);
const option = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
const ledger = process.env.KRAKA_PI_LEDGER;
const control = process.env.KRAKA_PI_CONTROL;
const pid = process.pid;
function diagnostic(message: string) {
  const line = `Pi fixture PID ${pid}: ${message}\n`;
  if (ledger) appendFileSync(`${ledger}.${pid}.stderr`, line);
  writeSync(2, line);
}
process.on("uncaughtExceptionMonitor", (error) => diagnostic(error.message));
let epoch = 0,
  position = 0;
function record(event: string, details: object = {}) {
  const row = { event, pid, epoch, ...details };
  if (ledger) appendFileSync(ledger, `${JSON.stringify(row)}\n`);
  return row;
}
async function signal(event: string, details: object = {}) {
  const row = record(event, details);
  if (control) {
    const response = await fetch(control, { method: "POST", body: JSON.stringify(row) });
    if (!response.ok) throw Error("Fixture signal failed");
  }
}
record("launch", { args, cwd: process.cwd(), account: process.env.PI_CODING_AGENT_DIR });
if (args.includes("--version")) {
  console.log("1.6.0");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "check") {
  console.log(JSON.stringify({ status: "ready" }));
  process.exit(0);
}
if (option("--mode") !== "rpc") process.exit(2);
const dir = option("--session-dir");
if (!dir || !process.env.PI_CODING_AGENT_DIR) throw Error("Missing isolated Pi directories");
mkdirSync(dir, { recursive: true });
const resume = option("--session");
const sessionId =
  resume && isAbsolute(resume)
    ? v.parse(
        v.object({ id: v.pipe(v.string(), v.uuid()) }),
        JSON.parse(readFileSync(resume, "utf8").split("\n")[0] ?? ""),
      ).id
    : (resume ?? crypto.randomUUID());
const sessionFile =
  resume && isAbsolute(resume)
    ? resume
    : join(
        dir,
        readdirSync(dir).find((f) => resume && f.endsWith(`_${resume}.jsonl`)) ??
          `fixture_${sessionId}.jsonl`,
      );
if (resume && !existsSync(sessionFile)) throw Error("Missing fixture session");
const model = { provider: "sample-provider", id: "sample-chat", name: "Sample Chat" };
const commands: { name: string; source: string }[] = [];
type ToolHook = (
  e: { toolName: string; input: object },
  ctx: { ui: { confirm: (title: string, message: string) => Promise<boolean> } },
) => Promise<{ block: boolean } | undefined>;
let hook: ToolHook | undefined;
if (!process.env.KRAKA_PI_MISSING_BRIDGE) {
  const path = option("--extension");
  if (path) {
    const extension = await import(pathToFileURL(path).href);
    extension.default({
      registerCommand(name: string) {
        commands.push({ name, source: "extension" });
      },
      on(event: string, listener: ToolHook) {
        if (event === "tool_call") hook = listener;
      },
    });
  }
}
function frame(data: object) {
  writeSync(1, `${JSON.stringify(data)}\n`);
}
function assistant(stopReason: string, content: object[] = []) {
  return { role: "assistant", stopReason, content };
}
const recording = errorRecording
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line))
  .filter((row) => row.direction === "fromExecutor")
  .map((row) => row.frame);
let historyRead = 0;
let scenario = "",
  questions = 0;
const approval: { resolve?: (allow: boolean) => void } = {};
const ui = (id: string, method: string, title: string, extra: object = {}) => {
  frame({ type: "extension_ui_request", id, method, title, ...extra });
  return signal("uiRequest", { id });
};
function settle() {
  frame({ type: "message_end", message: assistant("stop") });
  frame({ type: "agent_settled", aborted: false });
}
async function runPrompt(text: string, reply: (data: object) => void) {
  scenario = text;
  if (!existsSync(sessionFile))
    writeFileSync(
      sessionFile,
      `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd() })}\n`,
    );
  if (text === "handled") {
    reply({ disposition: "handled" });
    return;
  }
  if (text === "queued") {
    frame({ type: "queue_update", steering: [], followUp: [text] });
    reply({ disposition: "queued" });
  } else reply({ disposition: "started" });
  frame({ type: "agent_start" });
  if (text === "queued") {
    await signal("queued");
    frame({ type: "queue_update", steering: [], followUp: [] });
    frame({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
  }
  await signal("agentStarted", { attempt: text });
  switch (text) {
    case "error":
    case "retry":
      for (const event of recording) {
        if (!["response", "agent_start", "agent_settled"].includes(event.type)) frame(event);
      }
      if (text === "retry") {
        frame({ type: "auto_retry_start" });
        frame({ type: "turn_start" });
        frame({ type: "message_end", message: assistant("stop") });
      }
      frame({ type: "agent_settled", aborted: false });
      return;
    case "questions":
      questions = 1;
      await ui("question-1", "select", "Pick a color", { options: ["jade", "ochre"] });
      return;
    case "pipe": {
      await ui("pipe-question", "input", "Reply before disconnect");
      await signal("beforePipeClose");
      const output = await closePeerOutput();
      diagnostic(output);
      await signal("pipeClosed", { output });
      return;
    }
    case "observe":
      frame({
        type: "tool_execution_start",
        toolCallId: "call-7",
        toolName: "read",
        args: { path: "private" },
      });
      await signal("beforeHistoryLink");
      frame({
        type: "message_end",
        message: assistant("toolUse", [{ type: "toolCall", id: "call-7" }]),
      });
      return;
    case "policy": {
      if (!hook) throw Error("Policy hook unavailable");
      const result = await hook(
        { toolName: "bash", input: { command: "fixture operation" } },
        {
          ui: {
            confirm: (title, message) => {
              const result = Promise.withResolvers<boolean>();
              approval.resolve = result.resolve;
              void ui("approval", "confirm", title, { message });
              return result.promise;
            },
          },
        },
      );
      await signal("toolDecision", { blocked: result?.block ?? false });
      settle();
      return;
    }
    default:
      settle();
  }
}
const commandSchema = v.looseObject({ id: v.string(), type: v.string() });
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  const cmd = v.parse(commandSchema, JSON.parse(line));
  const match = /^pi-(\d+)-\d+$/.exec(cmd.id);
  if (match) epoch = Number(match[1]);
  await signal("frameRead", { position: ++position, frame: cmd });
  const reply = (data: object) =>
    frame({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
  switch (cmd.type) {
    case "get_state":
      reply({ sessionId, sessionFile, model, isStreaming: false, pendingMessageCount: 0 });
      break;
    case "get_commands":
      reply({ commands });
      break;
    case "get_available_models":
      reply({ models: [model] });
      break;
    case "prompt":
      void runPrompt(v.parse(v.string(), cmd.message), reply).catch((error) => {
        diagnostic(error instanceof Error ? error.message : String(error));
        process.exit(3);
      });
      break;
    case "extension_ui_response":
      if (approval.resolve && cmd.id === "approval") {
        approval.resolve(cmd.confirmed === true);
        delete approval.resolve;
      }
      if (scenario === "questions" && cmd.id === "question-1" && questions === 1) {
        questions++;
        await ui("question-2", "input", "Next answer");
      }
      break;
    case "get_entries": {
      historyRead++;
      const entry = historyRead === 3 ? "conflicting-native-item" : "assistant-native-8";
      await signal(historyRead === 1 ? "historyRead" : `historyReplay${historyRead}`);
      const message = assistant("toolUse", [{ type: "toolCall", id: "call-7" }]);
      reply({ entries: [{ type: "message", id: entry, parentId: null, message }], leafId: entry });
      if (historyRead < 3) frame({ type: "message_end", message });
      else frame({ type: "tool_execution_start", toolCallId: "proofs-drained" });
      break;
    }
    case "abort":
      reply({});
      if (scenario === "observe") {
        for (let i = 0; i < 42; i++)
          frame({ type: "tool_execution_start", toolCallId: `older-window-${i}` });
      }
      frame({ type: "agent_settled", aborted: true });
      break;
    default:
      frame({
        id: cmd.id,
        type: "response",
        command: cmd.type,
        success: false,
        error: "Unknown fixture command",
      });
  }
}
record("stdinClosed");
