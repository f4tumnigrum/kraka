import { test, expect, beforeAll, afterAll } from "bun:test";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import * as v from "valibot";
import {
  ExecutorInstanceIdSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
} from "@kraka/protocol";
import type { AdapterEventPayload } from "@kraka/environment";
import { claudeDecisionStore } from "../../../tools/fixtures/claude-decision";
import { claudePeerControl } from "../../../tools/fixtures/claude-peer-control";
import { Journal } from "../../../tools/fixtures/route-network";
import { createClaudeCodeAdapter } from "./adapter";

let dir: string, executable: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "kraka-claude-sdk-"));
  executable = join(dir, process.platform === "win32" ? "peer.exe" : "peer");
  const child = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      resolve(import.meta.dir, "../../../tools/fixtures/claude-cli-peer.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  if (code !== 0) throw Error(error);
}, 60000);
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
});
const instance = {
  family: "claude-code",
  instanceId: v.parse(ExecutorInstanceIdSchema, "claude-sdk-test"),
} as const;
const ticket = () => ({
  attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
  deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
});
function permit<C extends "submitTextInput" | "answerApprovalChoices" | "stopRound">(
  capability: C,
) {
  return { ...instance, capabilityVersion: 1, capability, support: { kind: "native" as const } };
}
async function open(
  mode: "command" | "interrupt" | "edit",
  adapter = createClaudeCodeAdapter({ executable }),
) {
  const control = claudePeerControl();
  const id = v.parse(MessageIdSchema, crypto.randomUUID()),
    ids = ticket();
  const cwd = await mkdtemp(join(dir, "query-")),
    config = join(cwd, "account");
  await mkdir(config);
  if (mode === "edit") await writeFile(join(cwd, "note.txt"), "old\n");
  const opened = await adapter.open({
    instance,
    resume: null,
    ...ids,
    setup: {
      workingDirectory: cwd,
      additionalDirectories: [],
      model: { id: "claude-sonnet-4-6", options: {} },
      permission: { selected: "ask", ceiling: "ask" },
      environment: {
        CLAUDE_CONFIG_DIR: config,
        KRAKA_CLAUDE_PEER: control.url,
        KRAKA_CLAUDE_CASE: mode,
      },
    },
  });
  if (opened.kind !== "ok") {
    await control.close();
    throw Error(JSON.stringify(opened));
  }
  const session = opened.value,
    handle = session.handle;
  const history = new Journal<AdapterEventPayload>();
  const reader = (async () => {
    for await (const event of adapter.events(session, null)) history.push(event.payload);
  })();
  const close = async () => {
    try {
      control.release(handle.binding.nativeSessionId, id);
      await adapter.close(session, "shutdown");
      await reader;
    } finally {
      await control.close();
    }
  };
  try {
    const sent = await adapter.invoke(session, permit("submitTextInput"), {
      kind: "deliverInput",
      capability: "submitTextInput",
      ...ids,
      input: { id, text: "Fixture request", references: [], attachments: [] },
    });
    expect(sent).toEqual({ kind: "ok", value: { kind: "written", deliveryId: ids.deliveryId } });
    const wait = async <K extends AdapterEventPayload["kind"]>(kind: K) => {
      const event = await history.until((p) => p.kind === kind || p.kind === "sessionLost");
      if (event.kind !== kind) throw Error(JSON.stringify(event));
      return event as Extract<AdapterEventPayload, { kind: K }>;
    };
    return { adapter, session, ids, id, handle, control, close, history, wait, cwd };
  } catch (error) {
    await close();
    throw error;
  }
}
const decisions = {
  allow: { kind: "approval", choiceKey: "allow", scope: "once", decision: "allow" },
  deny: { kind: "approval", choiceKey: "deny", scope: "once", decision: "deny" },
} as const;
test("One tool request accepts one decision", async () => {
  const f = await open("command");
  const binding = f.handle.binding;
  try {
    const opened = await f.wait("requestOpened");
    expect(opened.body).toMatchObject({
      requestedTool: { id: opened.nativeNode, target: "sleep 31 && printf cedar" },
    });
    expect(f.handle.sdkVersion).toBe("0.3.332");
    expect(f.handle.init).toMatchObject({
      claude_code_version: "2.1.332",
      permissionMode: "default",
    });
    const event = f.handle.records.find((e) => e.payload === opened);
    if (!event) throw Error("Missing original SDK envelope");
    const store = await claudeDecisionStore(f.cwd, f.session, f.adapter, event);
    try {
      const [first, loser] = await Promise.all(
        ["device-a", "device-b"].map((id, index) =>
          Promise.resolve().then(() =>
            store.command(id, index === 0 ? decisions.allow : decisions.deny),
          ),
        ),
      );
      expect(first).toMatchObject({ kind: "accepted", result: { kind: "todoAnswerStored" } });
      expect(loser).toMatchObject({ kind: "rejected", failure: { kind: "todoChanged" } });
      for (const device of ["device-a", "device-b"]) {
        expect(store.command(device)).toMatchObject({
          kind: "accepted",
          result: { authorId: "device-a", deviceId: "device-a", content: decisions.allow },
        });
      }
      await f.control.waitFor("completed", binding.nativeSessionId, "toolu_sample_cabinet");
    } finally {
      store.close();
    }
    const response = await f.control.waitFor("answer", binding.nativeSessionId, opened.requestId);
    expect(response.detail).toMatchObject({
      behavior: "allow",
      updatedInput: { command: "sleep 31 && printf cedar" },
    });
    expect(await f.wait("roundEnded")).toMatchObject({
      nativeRootTurnId: f.id,
      outcome: { reason: "completed" },
    });
    expect(f.history.items.some((e) => e.kind === "contentDelta" && e.finalText === "cedar")).toBe(
      true,
    );
  } finally {
    await f.close();
  }
  expect(f.control.count("eof", binding.nativeSessionId, binding.nativeSessionId)).toBe(1);
  expect(f.control.count("answer", binding.nativeSessionId, "sample-request-one")).toBe(1);
}, 25000);
test("A success subtype can describe a stopped turn", async () => {
  const f = await open("interrupt"),
    session = f.handle.binding.nativeSessionId;
  try {
    await f.wait("contentDelta");
    const stopDelivery = ticket().deliveryId;
    expect(
      await f.adapter.invoke(f.session, permit("stopRound"), {
        kind: "stop",
        capability: "stopRound",
        attemptId: f.ids.attemptId,
        deliveryId: stopDelivery,
      }),
    ).toEqual({ kind: "ok", value: { kind: "written", deliveryId: stopDelivery } });
    await f.control.waitFor("held", session, f.id);
    expect(f.handle.state?.ended).toBe(false);
    f.control.release(session, f.id);
    const ended = await f.wait("roundEnded");
    expect(ended).toMatchObject({
      attemptId: f.ids.attemptId,
      nativeRootTurnId: f.id,
      outcome: { reason: "stopped", nativeReason: "aborted_streaming" },
      endTimeEvidence: {
        source: "environmentObserved",
        executorEndedAt: null,
        environmentObservedAt: ended.endedAt,
      },
    });
  } finally {
    await f.close();
  }
  expect(f.control.count("interrupt", session, f.id)).toBe(1);
}, 25000);
test("A replacement query rejects an old callback", async () => {
  const first = await open("command");
  const old = await (async () => {
    try {
      return await first.wait("requestOpened");
    } finally {
      await first.close();
    }
  })();
  const second = await open("command", first.adapter),
    session = second.handle.binding.nativeSessionId;
  try {
    const current = await second.wait("requestOpened");
    expect(current.requestId).toBe(old.requestId);
    expect(second.session.epoch).toBe(first.session.epoch + 1);
    if (!old.nativeNode) throw Error("Missing native tool");
    expect(
      second.handle.resolveTool({
        binding: first.handle.binding,
        toolUseId: old.nativeNode,
        requestId: old.requestId,
        deliveryId: ticket().deliveryId,
        answer: decisions.allow,
      }),
    ).toMatchObject({ kind: "rejected", reason: "requestExpired" });
    expect(second.handle.approvals.pending.has(current.requestId)).toBe(true);
  } finally {
    await second.close();
  }
  expect(second.control.count("eof", session, session)).toBe(1);
  expect(second.control.count("answer", session, old.requestId)).toBe(0);
}, 25000);
test("An approved Edit changes the requested file", async () => {
  const f = await open("edit");
  try {
    const pending = await f.wait("requestOpened");
    expect(await readFile(join(f.cwd, "note.txt"), "utf8")).toBe("old\n");
    if (!pending.nativeNode) throw Error("Missing edit tool");
    const result = f.handle.resolveTool({
      binding: f.handle.binding,
      requestId: pending.requestId,
      toolUseId: pending.nativeNode,
      deliveryId: ticket().deliveryId,
      answer: decisions.allow,
    });
    expect(result.kind).toBe("ok");
    await f.wait("roundEnded");
    expect(await readFile(join(f.cwd, "note.txt"), "utf8")).toBe("new\n");
    expect(f.history.items).toContainEqual(
      expect.objectContaining({
        kind: "toolActivity",
        phase: "ended",
        changes: [{ path: "note.txt", change: "modified", destination: null, patch: null }],
      }),
    );
  } finally {
    await f.close();
  }
}, 25000);
