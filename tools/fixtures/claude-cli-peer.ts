import { createInterface } from "node:readline";
import { readFile, writeFile } from "node:fs/promises";
import * as v from "valibot";
import command from "../../fixtures/executors/claude-code/command-approval.jsonl" with {
  type: "text",
};
import interrupt from "../../fixtures/executors/claude-code/interrupt.jsonl" with { type: "text" };

const obj = v.record(v.string(), v.unknown());
const wire = (x: unknown) => v.parse(obj, x);
function recording(text: string) {
  return text
    .trim()
    .split("\n")
    .map((line) => wire(JSON.parse(line)))
    .filter((row) => row.kind === "frame")
    .map((row) => wire(row.frame));
}
const requestId = "sample-request-one",
  toolUseID = "toolu_sample_cabinet";
async function run() {
  if (process.argv.includes("--version")) {
    console.log("2.1.332 (Claude Code)");
    return;
  }
  const address = process.env.KRAKA_CLAUDE_PEER;
  if (!address || new URL(address).hostname !== "127.0.0.1")
    throw Error("Missing loopback fixture channel");
  const socket = new WebSocket(address);
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve();
    socket.onerror = () => reject(Error("Fixture control failed"));
  });
  let session = "",
    input = "",
    mode = "command",
    frames = recording(command);
  let terminal = false,
    held: string | null = null,
    requestPending = false;
  const write = (frame: object) => process.stdout.write(JSON.stringify(frame) + "\n");
  const send = (kind: string, key: string, detail: unknown = null) =>
    socket.send(JSON.stringify({ kind, key, session, detail }));
  function emit(index: number) {
    const raw = frames[index - 1];
    if (!raw) throw Error("Missing fixture frame " + index);
    const row = { ...raw, session_id: session };
    if (index === 2)
      Object.assign(row, {
        cwd: process.cwd(),
        model: option("--model"),
        permissionMode: option("--permission-mode"),
        tools: ["Bash", "Edit"],
      });
    if (index === 3 || raw.type === "result")
      Object.assign(row, { user_message_uuid: input, user_message_uuids: [input] });
    if (index === 2) send("init", input, row);
    write(row);
  }
  const option = (name: string) => {
    return process.argv.find((a) => a.startsWith(name + "="))?.slice(name.length + 1);
  };
  function finish() {
    if (terminal) return;
    terminal = true;
    if (mode === "interrupt") {
      emit(7);
      emit(8);
    } else emit(15);
    send("terminal", input);
  }
  socket.onmessage = (e) => {
    const msg = wire(JSON.parse(String(e.data)));
    if (msg.kind === "release" && msg.key === held && msg.session === session) {
      held = null;
      finish();
    }
  };
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      const row = wire(JSON.parse(line));
      if (row.type === "control_request") {
        const req = wire(row.request);
        if (req.subtype === "initialize") {
          write({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: row.request_id,
              response: {
                commands: [],
                agents: [],
                models: [
                  {
                    value: "claude-sonnet-4-6",
                    displayName: "Fixture model",
                    description: "Recorded CLI peer",
                  },
                ],
                output_style: "default",
                available_output_styles: ["default"],
                account: { tokenSource: "fixture" },
              },
            },
          });
        } else if (req.subtype === "interrupt") {
          send("interrupt", input);
          held = input;
          write({
            type: "control_response",
            response: {
              subtype: "success",
              request_id: row.request_id,
              response: { still_queued: [] },
            },
          });
          send("held", input);
        } else throw Error("Unexpected control request " + req.subtype);
      } else if (row.type === "user") {
        input = v.parse(v.string(), row.uuid);
        session = v.parse(v.string(), row.session_id);
        const scenario = process.env.KRAKA_CLAUDE_CASE;
        if (scenario !== "command" && scenario !== "edit" && scenario !== "interrupt")
          throw Error("Missing fixture case");
        mode = scenario;
        frames = recording(mode === "interrupt" ? interrupt : command);
        send("input", input);
        emit(2);
        if (mode === "interrupt") {
          emit(3);
          emit(4);
          send("text", input);
          continue;
        }
        let name = "Bash";
        let args = wire(v.parse(v.array(v.unknown()), frames[6]?.args)[1]);
        if (mode === "edit") {
          name = "Edit";
          args = { file_path: "note.txt", old_string: "old", new_string: "new" };
          const recorded = frames[4];
          if (!recorded) throw Error("Missing tool_use");
          const message = wire(recorded.message);
          write({
            ...recorded,
            message: {
              ...message,
              content: [{ type: "tool_use", id: toolUseID, name, input: args }],
            },
            session_id: session,
            user_message_uuid: input,
            user_message_uuids: [input],
          });
        } else {
          for (const n of [3, 4, 5, 6]) emit(n);
        }
        requestPending = true;
        write({
          type: "control_request",
          request_id: requestId,
          request: {
            subtype: "can_use_tool",
            tool_name: name,
            input: args,
            tool_use_id: toolUseID,
          },
        });
        send("request", requestId, { name, args });
      } else if (row.type === "control_response") {
        const envelope = wire(row.response);
        if (envelope.request_id !== requestId) throw Error("Unknown callback reply");
        send("answer", requestId, envelope.response ?? null);
        if (!requestPending) throw Error("Duplicate callback reply");
        requestPending = false;
        if (envelope.subtype !== "success" || wire(envelope.response).behavior !== "allow")
          continue;
        if (mode === "edit") {
          const result = wire(envelope.response);
          if (
            !Bun.deepEquals(result.updatedInput, {
              file_path: "note.txt",
              old_string: "old",
              new_string: "new",
            })
          )
            throw Error("Edit approval changed");
          if ((await readFile("note.txt", "utf8")) !== "old\n")
            throw Error("Unexpected fixture contents");
          await writeFile("note.txt", "new\n");
          const at = frames[9]!;
          write({
            ...at,
            session_id: session,
            message: {
              role: "user",
              content: [
                {
                  type: "tool_result",
                  tool_use_id: toolUseID,
                  content: "Updated note.txt",
                  is_error: false,
                },
              ],
            },
            tool_use_result: { filePath: "note.txt" },
          });
        } else {
          emit(9);
          emit(10);
          for (const n of [11, 12, 13, 14]) emit(n);
        }
        send("completed", toolUseID);
        finish();
      } else if (row.type !== "keep_alive") throw Error("Unexpected SDK input " + row.type);
    }
  } finally {
    send("eof", session);
    const closed = new Promise<void>((resolve) => {
      socket.onclose = () => resolve();
    });
    socket.close();
    await closed;
    lines.close();
  }
}
await run();
