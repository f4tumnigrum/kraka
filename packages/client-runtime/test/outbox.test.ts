import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  EnvironmentIdSchema,
  MessageIdSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  ThreadIdSchema,
  type CommandReceipt,
  type MessageId,
  type SignedRequest,
} from "@kraka/protocol";
import { openLocalInputs } from "../hosts/sqlite";
import { InputOutbox, inputScopeKey, type OutboxConnection, type OrdinaryReceipt } from "../src";

const scope = {
  principalId: v.parse(PrincipalIdSchema, "person"),
  environmentId: v.parse(EnvironmentIdSchema, "env"),
  threadId: v.parse(ThreadIdSchema, "thread"),
};
const content = { text: "same 🪁\n", attachments: [], references: [] };
const signature = "a".repeat(86);
const envelope = {
  kind: "signedRequest",
  environmentId: scope.environmentId,
  protocolVersion: { major: 1, minor: 0 },
  signer: { kind: "device", deviceId: "device", keyId: "key" },
  challengeId: "challenge",
  challenge: "a".repeat(43),
  signature,
  sequence: 2,
};
function scheduled(request: OrdinaryReceipt["request"], id: string) {
  return v.parse(CommandReceiptSchema, {
    kind: "accepted",
    commandId: request.commandId,
    result: {
      kind: "inputScheduled",
      messageId: id,
      attemptId: "a",
      roundId: "r",
      deliveryId: "d",
    },
  });
}
async function scenario(work: (f: ReturnType<typeof setup>) => Promise<void>) {
  const f = setup();
  try {
    await work(f);
  } finally {
    f.close();
  }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "kraka-input-unit-")),
    path = join(dir, "local.sqlite");
  const local = openLocalInputs(path);
  const calls: OrdinaryReceipt["request"][] = [];
  const installed = new Set<MessageId>();
  let session: string | null = "first",
    now = 1000;
  let reply: (r: OrdinaryReceipt["request"]) => Promise<CommandReceipt | null> = async () => null;
  // Drive elapsed time independently of SQLite and packet delivery.
  const host = {
    state: local.state,
    random: { bytes: (n: number) => crypto.getRandomValues(new Uint8Array(n)) },
    now: () => now,
    utf8: {
      encode: (s: string) => new TextEncoder().encode(s),
      decode: (b: Uint8Array) => new TextDecoder().decode(b),
    },
    withSender: <T>(_key: string, work: () => Promise<T>) => work(),
  };
  const outbox = new InputOutbox(host);
  const conn: OutboxConnection = {
    writable: (s) => (inputScopeKey(s) === inputScopeKey(scope) ? session : null),
    async send(intent) {
      const request = v.parse(REQUEST_METHODS.sendInput.schema, {
        ...envelope,
        ...intent,
        connectionId: session,
      });
      calls.push(request);
      const receipt = await reply(request);
      return receipt ? { principalId: scope.principalId, request, receipt } : null;
    },
    installed: async (_scope, id) => installed.has(id),
  };
  return {
    dir,
    path,
    host,
    outbox,
    conn,
    calls,
    installed,
    local,
    advance: (ms: number) => {
      now += ms;
    },
    session: (s: string | null) => {
      session = s;
    },
    reply: (f: typeof reply) => {
      reply = f;
    },
    async queue(text = content.text) {
      const d = await outbox.saveDraft(scope, text);
      return outbox.queueInput(scope, d.revision);
    },
    close() {
      local.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test("both arrival orders reconcile only the numbered frozen send and installed message", () =>
  scenario(async (f) => {
    const first = await f.queue(),
      second = await f.queue();
    const latest = await f.outbox.saveDraft(scope, "still editing");
    const ids = ["first-M", "second-M"].map((id) => v.parse(MessageIdSchema, id));
    f.reply(async (request) =>
      scheduled(request, request.commandId === first.commandId ? ids[0]! : ids[1]!),
    );
    await f.outbox.flushHead(scope, f.conn);
    let s = await f.outbox.inspect(scope);
    expect(s.queue.items[0]?.progress).toEqual({ kind: "accepted", messageId: ids[0]! });
    expect(s.receipts.bindings).toEqual({});
    f.installed.add(ids[1]!);
    await f.outbox.flushHead(scope, f.conn);
    s = await f.outbox.inspect(scope);
    expect(s.receipts.bindings).toEqual({ [second.commandId]: ids[1]! });
    f.installed.add(ids[0]!);
    await f.outbox.reflectInstalled(scope, f.conn.installed);
    s = await f.outbox.inspect(scope);
    expect(s.queue.items).toBeEmpty();
    expect(s.receipts.bindings[first.commandId]).toBe(ids[0]!);
    expect(s.drafts.current).toEqual(latest);
    expect(f.calls.map((r) => r.commandId)).toEqual([first.commandId, second.commandId]);
  }));
test("a handoff receipt, another subject, and an altered signed payload cannot accept an ordinary send", () =>
  scenario(async (f) => {
    const head = await f.queue(),
      draft = await f.outbox.saveDraft(scope, "new draft");
    await f.outbox.flushHead(scope, f.conn);
    const request = f.calls[0]!,
      receipt = scheduled(request, "actual");
    const target = { environmentId: scope.environmentId, threadId: scope.threadId };
    const returned = v.parse(CommandReceiptSchema, {
      kind: "accepted",
      commandId: head.commandId,
      result: {
        kind: "textReturned",
        source: { ...target, roundId: "r" },
        target,
        transferId: "transfer",
        history: { coverage: "unknown", omittedItems: null },
        text: content.text,
        input: { messageId: "foreign", roundId: "r", deliveryId: "d", attemptId: "a" },
      },
    });
    f.installed.add(v.parse(MessageIdSchema, "foreign"));
    await f.outbox.reconcileReceipt(scope, {
      request,
      principalId: scope.principalId,
      receipt: returned,
    });
    await f.outbox.reconcileReceipt(scope, {
      request,
      principalId: v.parse(PrincipalIdSchema, "another"),
      receipt,
    });
    await f.outbox.reconcileReceipt(scope, {
      request: {
        ...request,
        payload: { ...request.payload, content: { ...content, text: "different" } },
      },
      principalId: scope.principalId,
      receipt,
    });
    await f.outbox.reflectInstalled(scope, f.conn.installed);
    expect((await f.outbox.inspect(scope)).queue.items[0]?.progress.kind).toBe("sending");
    expect((await f.outbox.inspect(scope)).drafts.current).toEqual(draft);
  }));
test("every retry delay, capped retries, authority loss and a newly ready session", () =>
  scenario(async (f) => {
    const head = await f.queue();
    f.session(null);
    await f.outbox.flushHead(scope, f.conn);
    expect(f.calls).toBeEmpty();
    await f.outbox.flushHead(
      { ...scope, principalId: v.parse(PrincipalIdSchema, "other") },
      f.conn,
    );
    expect(f.calls).toBeEmpty();
    f.session("first");
    for (const [i, after] of [1000, 2000, 4000, 8000, 16000, 16000, 16000].entries()) {
      expect(await f.outbox.flushHead(scope, f.conn)).toEqual({ kind: "retry", after });
      f.advance(after - 1);
      expect(await f.outbox.flushHead(scope, f.conn)).toEqual({ kind: "retry", after: 1 });
      expect(f.calls.length).toBe(i + 1);
      f.advance(1);
    }
    await f.outbox.flushHead(scope, f.conn);
    f.session("second");
    await f.outbox.flushHead(scope, f.conn);
    expect(f.calls).toHaveLength(9);
    expect(new Set(f.calls.map((r) => r.commandId))).toEqual(new Set([head.commandId]));
  }));
test("transaction failure keeps draft bytes, clearing the cache keeps queued input, unreadable format blocks sending", () =>
  scenario(async (f) => {
    const d = await f.outbox.saveDraft(scope, content.text);
    const db = new DatabaseSync(f.path);
    try {
      db.exec(
        "CREATE TRIGGER refuse BEFORE INSERT ON local_state WHEN NEW.key LIKE 'queue/%' BEGIN SELECT RAISE(ABORT,'quota'); END",
      );
      await expect(f.outbox.queueInput(scope, d.revision)).rejects.toThrow("quota");
      expect((await f.outbox.inspect(scope)).drafts.current).toEqual(d);
      db.exec("DROP TRIGGER refuse");
      const newer = await f.outbox.saveDraft(scope, "new");
      await expect(f.outbox.queueInput(scope, d.revision)).rejects.toThrow("Draft changed");
      const p = await f.outbox.queueInput(scope, newer.revision);
      await f.local.state.commit([{ key: "cache/thread/" + inputScopeKey(scope), value: null }]);
      expect((await f.outbox.inspect(scope)).queue.items).toEqual([p]);
      const key = "queue/" + inputScopeKey(scope),
        bad = new TextEncoder().encode('{"format":2}');
      await f.local.state.commit([{ key, value: bad }]);
      await expect(f.outbox.flushHead(scope, f.conn)).rejects.toThrow();
      expect(await f.local.state.read(key)).toEqual(bad);
      expect(f.calls).toBeEmpty();
    } finally {
      db.close();
    }
  }));
test("definite rejection preserves a newer draft and never schedules another send", () =>
  scenario(async (f) => {
    await f.queue();
    const edit = await f.outbox.saveDraft(scope, "newer");
    f.reply(async (r) => ({
      kind: "rejected",
      commandId: r.commandId,
      failure: { kind: "invalidState" },
    }));
    await f.outbox.flushHead(scope, f.conn);
    await f.outbox.flushHead(scope, f.conn);
    const s = await f.outbox.inspect(scope);
    expect(s.drafts.current).toEqual(edit);
    expect(s.drafts.returned[0]?.content).toEqual(content);
    expect(s.queue.items).toBeEmpty();
    expect(f.calls).toHaveLength(1);
  }));
test("two SQLite host connections admit only one sender for the thread", () =>
  scenario(async (f) => {
    await f.queue();
    const other = openLocalInputs(f.path),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.reply(async (r) => {
      entered.resolve();
      await release.promise;
      return scheduled(r, "m");
    });
    const first = f.local.outbox.flushHead(scope, f.conn);
    try {
      await entered.promise;
      await other.outbox.flushHead(scope, f.conn);
      expect(f.calls.length).toBe(1);
    } finally {
      release.resolve();
      await first;
      other.close();
    }
  }));
test("only ordinary content enters the durable queue and queue-edit conflicts retain their original base", () =>
  scenario(async (f) => {
    for (const method of ["todo.decide", "todo.answer", "todo.submitSecret"]) {
      const decision: unknown = { method, payload: { value: "private" } };
      expect(() => f.outbox.saveDraft(scope, decision as string)).toThrow();
    }
    expect((await f.outbox.inspect(scope)).queue.items).toBeEmpty();
    const command = v.parse(REQUEST_METHODS.editQueued.schema, {
      ...envelope,
      connectionId: "c",
      method: "input.editQueued",
      commandId: crypto.randomUUID(),
      payload: { threadId: scope.threadId, roundId: "r", baseVersion: "7", content },
    });
    const prior = await f.outbox.saveQueueEdit(scope, {
      kind: "editing",
      environmentId: scope.environmentId,
      ...command.payload,
    });
    const next = await f.outbox.saveQueueEdit(scope, {
      ...prior.draft,
      content: { ...content, text: "later" },
    });
    await f.outbox.settleQueueEdit(
      scope,
      prior.revision,
      { ...command, commandId: prior.commandId },
      v.parse(CommandReceiptSchema, {
        kind: "rejected",
        commandId: prior.commandId,
        failure: {
          kind: "queueConflict",
          threadId: scope.threadId,
          roundId: "r",
          currentVersion: null,
          reason: "leftQueue",
        },
      }),
    );
    const edits = (await f.outbox.inspect(scope)).drafts.edits;
    expect(edits[0]?.draft).toEqual({ ...prior.draft, kind: "conflict", currentVersion: null });
    expect(edits[1]).toEqual(next);
  }));
