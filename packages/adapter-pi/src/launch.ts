import { mkdtemp, realpath, rm, writeFile, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import * as v from "valibot";
import { NativeSessionIdSchema, type PermissionMode } from "@kraka/protocol";
import { PiRpc, type PiProcess } from "./rpc";
import { PiError, stateSchema } from "./native";

export type PiLaunch = PiProcess & {
  accountDirectory: string;
  sessionDirectory: string;
  toolPolicy: "builtin" | null;
};
export function piEnvironment(launch: PiLaunch) {
  return {
    ...launch.env,
    PI_CODING_AGENT_DIR: launch.accountDirectory,
    PI_CODING_AGENT_SESSION_DIR: launch.sessionDirectory,
  };
}
const commands = v.object({
  commands: v.array(v.object({ name: v.string(), source: v.string() })),
});
const sessionHeader = v.object({
  type: v.literal("session"),
  id: v.pipe(v.string(), v.uuid()),
  cwd: v.string(),
});
async function verifiedFile(file: string, launch: PiLaunch) {
  const path = await realpath(file);
  const child = relative(await realpath(launch.sessionDirectory), path);
  if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child))
    throw Error("Pi session is outside its directory");
  const fd = await open(path, "r");
  try {
    const buf = Buffer.alloc(65536);
    const { bytesRead } = await fd.read(buf, 0, buf.length, 0);
    const end = buf.subarray(0, bytesRead).indexOf(10);
    if (end < 0) throw Error("Missing Pi session header");
    const header = v.parse(sessionHeader, JSON.parse(buf.toString("utf8", 0, end)));
    if ((await realpath(header.cwd)) !== (await realpath(launch.cwd)))
      throw Error("Pi session identity changed");
    return { path, id: header.id };
  } finally {
    await fd.close();
  }
}
export async function openPiProcess(
  launch: PiLaunch,
  epoch: number,
  mode: PermissionMode,
  target: { kind: "probe" } | { kind: "session"; resume: string | null; model: string },
) {
  if (
    launch.toolPolicy !== "builtin" ||
    !isAbsolute(launch.accountDirectory) ||
    !isAbsolute(launch.sessionDirectory)
  )
    throw new PiError(
      "unsupported",
      "Isolated Pi directories and a trusted tool policy are required",
    );
  const directory = await mkdtemp(join(tmpdir(), "kraka-pi-policy-"));
  const marker = `kraka-policy-${crypto.randomUUID()}`;
  const approvalTitle = `Kraka ${marker}`;
  const path = join(directory, "policy.mjs");
  let rpc: PiRpc | undefined;
  async function close() {
    try {
      await rpc?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    await writeFile(
      path,
      `export default function policy(pi) {
  const mode = ${JSON.stringify(mode)};
  const readonly = new Set(["read", "grep", "find", "ls"]);
  pi.on("tool_call", async (event, ctx) => {
    const name = event.toolName;
    const file = name === "edit" || name === "write";
    if (readonly.has(name) || (file && mode === "edits") || mode === "open") return;
    const title = ${JSON.stringify(approvalTitle)} + (file ? " file" : " command");
    if (!(await ctx.ui.confirm(title, name + " " + JSON.stringify(event.input)))) {
      return {block:true, reason:"Tool was not approved"};
    }
  });
  pi.registerCommand(${JSON.stringify(marker)}, {description:"Kraka tool policy", handler:async () => {}});
}
`,
      { mode: 0o600, flag: "wx" },
    );
    const args = [
      "--mode",
      "rpc",
      "--session-dir",
      launch.sessionDirectory,
      "--no-extensions",
      "--extension",
      path,
      "--tools",
      "read,grep,find,ls,edit,write,bash",
    ];
    const expectedFile =
      target.kind === "session" && target.resume && isAbsolute(target.resume)
        ? await verifiedFile(target.resume, launch)
        : null;
    if (target.kind === "probe") args.push("--no-session");
    else if (target.resume !== null) {
      if (!expectedFile && !v.is(v.pipe(v.string(), v.uuid()), target.resume))
        throw Error("Expected full Pi session UUID");
      args.push("--session", expectedFile?.path ?? target.resume);
    } else {
      const split = target.model.indexOf("/");
      if (split < 1) throw Error("Expected provider/model");
      args.push(
        "--provider",
        target.model.slice(0, split),
        "--model",
        target.model.slice(split + 1),
      );
    }
    rpc = new PiRpc({ ...launch, env: piEnvironment(launch) }, args, epoch);
    const state = v.parse(stateSchema, await rpc.request("get_state", {}, 10_000));
    const catalog = v.parse(commands, await rpc.request("get_commands"));
    if (!catalog.commands.some((c) => c.name === marker && c.source === "extension"))
      throw new PiError("unsupported", "Pi did not load the trusted tool policy");
    if (state.isStreaming || state.pendingMessageCount !== 0)
      throw Error("Pi session is already active");
    if (target.kind === "session") {
      if (!state.model || `${state.model.provider}/${state.model.id}` !== target.model)
        throw Error("Pi model differs from selection");
      if (target.resume) {
        if (!state.sessionFile || state.sessionId !== (expectedFile?.id ?? target.resume))
          throw Error("Pi session changed");
        const actual = await verifiedFile(state.sessionFile, launch);
        if (actual.id !== state.sessionId || (expectedFile && actual.path !== expectedFile.path))
          throw Error("Pi session file changed");
      }
    }
    return {
      rpc,
      state,
      nativeSessionId: v.parse(NativeSessionIdSchema, state.sessionId),
      approvalTitle,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
