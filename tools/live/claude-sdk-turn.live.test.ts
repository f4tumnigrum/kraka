// Live cases 4; required groups ["1.", "2.", "3.", "4."]
// Live junit live.xml
import { beforeAll, afterAll, test, expect } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { hostRelease } from "../fixtures/installed";
import { installedClaude } from "../fixtures/claude-installed";
import { accepted } from "../fixtures/first-send";
import { git } from "../fixtures/isolated-start";

let root: string, peer: string, artifact: Awaited<ReturnType<typeof hostRelease>>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "kraka-s23-build-"));
  console.log(git(root, "--version"));
  artifact = await hostRelease(join(root, "release"));
  peer = join(root, process.platform === "win32" ? "peer.exe" : "peer");
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "../fixtures/claude-cli-peer.ts"),
      "--outfile",
      peer,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, errors] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw Error(errors);
}, 120000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
type Fixture = Awaited<ReturnType<typeof installedClaude>>;
type Replica = Awaited<ReturnType<Fixture["replica"]>>;
const allow = { kind: "approval", choiceKey: "allow", decision: "allow", scope: "once" } as const;
const deny = { kind: "approval", choiceKey: "deny", decision: "deny", scope: "once" } as const;
async function pending(replica: Replica) {
  const data = await replica.snapshots.until((p) => p.todos.some((t) => t.state.kind === "open"));
  const todo = data.todos.find((t) => t.state.kind === "open");
  if (!todo || todo.state.kind !== "open" || todo.state.route.kind !== "live")
    throw Error("Expected live request");
  return {
    todo,
    route: todo.state.route,
    target: { threadId: todo.threadId, todoRequestId: todo.id },
  };
}
async function settled(replica: Replica) {
  const data = await replica.snapshots.untilDispatch((p) =>
    p.rounds.some((r) => r.attempt.phase.kind === "finished"),
  );
  const round = data.rounds.find((r) => r.attempt.phase.kind === "finished");
  if (!round || round.attempt.phase.kind !== "finished") throw Error("Missing settled checkpoint");
  return { round, phase: round.attempt.phase, data };
}
test("1. Command approval and selected policy", async () => {
  const f = await installedClaude(artifact, peer, "command");
  let session = "",
    request = "",
    input = "";
  try {
    expect(f.refresh).toMatchObject({
      binaryVersion: "2.1.332",
      versionAdvisory: "Claude Agent SDK 0.3.332",
      snapshot: { family: "claude-code", permission: { ceiling: "ask", selected: "ask" } },
    });
    const ids = accepted(await f.start(), "threadStarted");
    const a = await f.replica(ids.threadId, f.owner),
      b = await f.replica(ids.threadId, f.phone);
    const A = await pending(a),
      B = await pending(b);
    expect(B.todo).toEqual(A.todo);
    session = A.route.sessionId;
    request = A.route.requestId;
    input = ids.messageId;
    const init = await f.control.waitFor("init", session, input);
    expect(init.detail).toMatchObject({
      permissionMode: "default",
      session_id: session,
      claude_code_version: f.refresh.binaryVersion,
    });
    const snap = await a.snapshots.until((p) =>
      p.rounds.some((r) => r.attempt.phase.kind === "working"),
    );
    expect(snap.rounds[0]).toMatchObject({
      executorPolicy: {
        selected: "ask",
        effective: "ask",
        supported: ["ask", "edits", "open"],
        enforcement: "native",
        sessionId: session,
      },
      attempt: { phase: { kind: "working", root: { sessionId: session, id: input } } },
    });
    expect(A.todo.body).toMatchObject({
      requestedTool: { id: "toolu_sample_cabinet", target: "sleep 31 && printf cedar" },
    });
    accepted(await a.rpc("todo.decide", { ...A.target, decision: allow }), "todoAnswerStored");
    expect(await b.rpc("todo.decide", { ...B.target, decision: deny })).toMatchObject({
      kind: "rejected",
      failure: { kind: "todoChanged" },
    });
    for (const replica of [a, b]) {
      expect(await replica.rpc("todo.readAnswer", A.target)).toMatchObject({
        kind: "accepted",
        result: { content: allow, deviceId: f.owner.device.deviceId },
      });
      const state = await settled(replica);
      expect(state.data.todos[0]).toMatchObject({ id: A.todo.id, state: { kind: "answered" } });
      expect(state.data.tools.some((t) => t.outputSummary === "cedar")).toBe(true);
    }
    expect(await f.start("open")).toMatchObject({
      kind: "rejected",
      failure: { kind: "unsupported" },
    });
  } finally {
    await f.close();
  }
  expect(f.control.count("input", session, input)).toBe(1);
  expect(f.control.totalInputs()).toBe(1);
  expect(f.control.count("answer", session, request)).toBe(1);
  expect(f.control.count("completed", session, "toolu_sample_cabinet")).toBe(1);
  expect(f.control.count("eof", session, session)).toBe(1);
}, 60000);
test("2. File approval and diff", async () => {
  const f = await installedClaude(artifact, peer, "edit");
  let session = "",
    request = "";
  try {
    const ids = accepted(await f.start(), "threadStarted"),
      a = await f.replica(ids.threadId, f.owner);
    const ask = await pending(a);
    session = ask.route.sessionId;
    request = ask.route.requestId;
    expect(ask.todo.body).toMatchObject({ tool: "file", requestedTool: { target: "note.txt" } });
    expect(await Bun.file(join(f.site.cwd, "note.txt")).text()).toBe("old\n");
    accepted(await a.rpc("todo.decide", { ...ask.target, decision: allow }), "todoAnswerStored");
    const { phase, data } = await settled(a);
    expect(data.todos[0]).toMatchObject({ id: ask.todo.id, state: { kind: "answered" } });
    expect(
      data.tools.some((t) => t.source.callId === "toolu_sample_cabinet" && t.phase === "ended"),
    ).toBe(true);
    expect(await a.rpc("todo.readAnswer", ask.target)).toMatchObject({
      kind: "accepted",
      result: { content: allow },
    });
    const dir = data.threads[0]?.directory;
    if (!dir) throw Error("Missing signed checkout");
    const base = {
      threadId: ids.threadId,
      directoryId: dir.directoryId,
      generation: dir.generation,
    };
    for (const query of [
      { kind: "workingTree" as const, ...base },
      { kind: "round" as const, ...base, captureId: phase.captureId },
    ]) {
      const result = accepted(
        await a.rpc("checkpoint.diff", { query, cursor: null }),
        "checkpointDiff",
      ).diff;
      if (result.kind !== "changed") throw Error(JSON.stringify(result));
      expect(result.files.map((x) => x.path)).toEqual(["note.txt"]);
      expect(result.patch).toContain("-old\n");
      expect(result.patch).toContain("+new\n");
    }
  } finally {
    await f.close();
  }
  expect(f.control.count("answer", session, request)).toBe(1);
}, 60000);
test("3. Interrupt outcome", async () => {
  const f = await installedClaude(artifact, peer, "interrupt");
  let session = "",
    input = "";
  try {
    const ids = accepted(await f.start(), "threadStarted"),
      a = await f.replica(ids.threadId, f.owner);
    const data = await a.snapshots.until((p) =>
      p.rounds.some((r) => r.attempt.phase.kind === "working"),
    );
    const round = data.rounds[0];
    if (round?.attempt.phase.kind !== "working") throw Error("Inactive round");
    session = round.attempt.phase.root.sessionId;
    input = ids.messageId;
    await f.control.waitFor("text", session, input);
    const stop = await a.rpc("round.stop", { threadId: ids.threadId, attemptId: ids.attemptId });
    accepted(stop, "actionAccepted");
    await f.control.waitFor("held", session, input);
    expect(
      accepted(
        await a.rpc("round.readStop", { threadId: ids.threadId, stopCommandId: stop.commandId }),
        "stopResult",
      ).disposition,
    ).toBe("pending");
    const reread = await f.replica(ids.threadId, f.phone);
    const current = await reread.snapshots.until((p) => p.rounds.some((r) => r.id === ids.roundId));
    expect(current.rounds[0]?.attempt.phase.kind).toBe("working");
    f.control.release(session, input);
    const done = await a.snapshots.until((p) =>
      p.rounds.some((r) => r.attempt.phase.kind === "endedEarly"),
    );
    expect(done.rounds).toMatchObject([
      {
        attempt: {
          attemptId: ids.attemptId,
          phase: { kind: "endedEarly", reason: "stopped", nativeReason: "aborted_streaming" },
        },
      },
    ]);
    await f.control.waitFor("eof", session, session);
  } finally {
    await f.close();
  }
  expect(f.control.count("interrupt", session, input)).toBe(1);
  expect(f.control.count("terminal", session, input)).toBe(1);
}, 60000);
test("4. Cached approval after restart", async () => {
  const f = await installedClaude(artifact, peer, "command");
  let old = "",
    next = "",
    key = "";
  try {
    const first = accepted(await f.start(), "threadStarted"),
      b = await f.replica(first.threadId, f.phone);
    const cached = await pending(b);
    old = cached.route.sessionId;
    key = cached.route.requestId;
    await b.end();
    await f.restart();
    const second = accepted(await f.start(), "threadStarted"),
      a = await f.replica(second.threadId, f.owner);
    const fresh = await pending(a);
    next = fresh.route.sessionId;
    expect(String(fresh.route.requestId)).toBe(key);
    expect(next).not.toBe(old);
    const restored = await f.replica(first.threadId, f.phone);
    const result = await restored.rpc("todo.decide", { ...cached.target, decision: allow });
    expect(result).toMatchObject({
      kind: "rejected",
      failure: {
        kind: "todoChanged",
        current: { id: cached.todo.id, state: { kind: "expired", reason: expect.any(String) } },
      },
    });
  } finally {
    await f.close();
  }
  expect(f.control.count("answer", next, key)).toBe(0);
  expect(f.control.count("eof", old, old)).toBe(1);
  expect(f.control.count("eof", next, next)).toBe(1);
}, 60000);
