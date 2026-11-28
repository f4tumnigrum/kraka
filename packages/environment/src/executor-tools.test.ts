import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandIdSchema,
  ObjectVersionSchema,
  DelegatedChildRecordSchema,
  HostInstanceIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
  PrincipalIdSchema,
  AttemptIdSchema,
  P256PublicKeySchema,
  canonicalJson,
  type AttemptId,
  SignedRequestSchema,
  RequestSignerSchema,
  StoredRegistrationSchema,
  type SignedRequest,
  type ThreadId,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import { replaceBinding } from "./executor-bindings";
import { openWriter } from "./writer";
import { openStore, readMessage } from "./first-send-store";
import { acceptFirstInput, registerProject } from "./first-send";
import { invokeExecutorTool } from "./executor-tools";
import { WriterExecutorRegistry } from "./executor-registry";
import { prepareChildResultTransfer } from "./child-results";
import { applyInputCommand } from "./input-command";

async function fixture(
  openNative?: (
    attempt: AttemptId,
    root: string,
  ) => Promise<{ nativeSessionId: string; publicKey: string }>,
) {
  const dir = mkdtempSync(join(tmpdir(), "kraka-exec-tools-"));
  const lock = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 3000,
  );
  if (lock.kind !== "writer") throw Error(lock.kind);
  const connections = new Set<ReturnType<typeof openStore>>();
  const open = () => {
    const store = openStore(lock.lease);
    connections.add(store);
    return store;
  };
  const close = (store: ReturnType<typeof openStore>) => {
    store.db.close(true);
    connections.delete(store);
  };
  const dispose = () => {
    for (const store of connections) close(store);
    lock.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  };
  try {
    const store = open(),
      environmentId = lock.lease.environmentId;
    const actor = { id: v.parse(PrincipalIdSchema, "owner"), environmentId, allows: () => true };
    const root = join(dir, "project");
    mkdirSync(root);
    const cmd = () => v.parse(CommandIdSchema, crypto.randomUUID());
    const project = registerProject({
      transaction: store,
      environmentId,
      actor,
      realPath: root,
      commandId: cmd(),
    });
    if (project.kind !== "accepted" || project.result.kind !== "projectRegistered")
      throw Error("Missing project");
    const projectId = project.result.project.id;
    const registration = v.parse(StoredRegistrationSchema, {
      family: "replay",
      instanceId: "replay",
      version: "1",
      enabled: true,
      displayName: "Replay",
      driver: {
        executable: null,
        endpoint: null,
        configurationRoot: null,
        historyRoot: null,
        variables: {},
      },
      credential: null,
      model: { id: "gpt-5.4", options: {} },
      permission: { ceiling: "ask", selected: "ask" },
    });
    await new WriterExecutorRegistry(store).save(registration, null);
    const start = () => {
      const result = acceptFirstInput({
        transaction: store,
        verifiedActor: actor,
        commandId: cmd(),
        threadStart: {
          projectId,
          worktreeId: null,
          content: { text: "hello", references: [], attachments: [] },
        },
        selected(id) {
          store.db.run("INSERT INTO round_executors VALUES(?,?,?,?)", [
            id,
            registration.instanceId,
            registration.version,
            JSON.stringify(registration.model),
          ]);
        },
      });
      if (result.kind !== "accepted" || result.result.kind !== "threadStarted")
        throw Error("Missing thread");
      return result.result;
    };
    const parent = start(),
      session = store.services.executorTools;
    const native = await openNative?.(parent.attemptId, root);
    const publicKey =
      native?.publicKey ??
      Buffer.from(
        await crypto.subtle.exportKey(
          "raw",
          (
            await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, [
              "sign",
              "verify",
            ])
          ).publicKey,
        ),
      ).toString("base64url");
    const binding = {
      family: registration.family,
      context: "fixture",
      threadId: parent.threadId,
      attemptId: parent.attemptId,
      instanceId: registration.instanceId,
      nativeSessionId: v.parse(NativeSessionIdSchema, native?.nativeSessionId ?? "native-parent"),
      epoch: 1,
    };
    expect(replaceBinding(store, null, binding)).toBe(true);
    const grant = session.register({
      binding,
      roundId: parent.roundId,
      instanceVersion: registration.version,
      publicKey,
      methods: ["inspectCheckout", "answerQuestion"],
    });
    if (!grant) throw Error("Failed to open executor grant");
    const request = (method: SignedRequest["method"], payload: unknown) =>
      v.parse(SignedRequestSchema, {
        kind: "signedRequest",
        protocolVersion: { major: 1, minor: 0 },
        environmentId,
        connectionId: "connection",
        challengeId: "challenge",
        challenge: "A".repeat(43),
        signer: { kind: "executor", principalId: grant.principal.id, keyId: grant.keyId },
        sequence: 1,
        commandId: cmd(),
        method,
        payload,
        signature: "A".repeat(86),
      });
    const invoke = (request: SignedRequest, allows = () => true) =>
      invokeExecutorTool({ transaction: store, grant, request, allows });
    const inspect = (threadId: ThreadId = parent.threadId) =>
      request("thread.inspectCheckout", { threadId });
    return {
      store,
      open,
      close,
      grant,
      start,
      parent,
      request,
      invoke,
      inspect,
      actor,
      root: realpathSync(root),
      registration,
      binding,
      [Symbol.dispose]: dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}

test("a tool grant reads only its bound thread", async () => {
  using f = await fixture();
  const first = f.inspect();
  expect(f.invoke(first)).toMatchObject({
    result: { checkout: { kind: "available", path: f.root, shared: false } },
  });
  expect(f.invoke(first, () => false)).toMatchObject({
    failure: { kind: "missingPermission", permission: "thread.view" },
  });
  const other = f.inspect(f.start().threadId);
  expect(f.invoke(other)).toEqual({
    kind: "rejected",
    commandId: other.commandId,
    failure: { kind: "notFound" },
  });
  expect(f.invoke(first)).toMatchObject({
    result: { checkout: { kind: "available", path: f.root, shared: false } },
  });
});

test("a replaced binding expires the old grant", async () => {
  using f = await fixture();
  const previous = f.inspect();
  f.invoke(previous);
  const next = { ...f.binding, epoch: 2 };
  const sessions = f.store.services.executorTools;
  expect(replaceBinding(f.store, f.binding, next)).toBe(true);
  expect(f.invoke(previous)).toEqual({
    kind: "rejected",
    commandId: previous.commandId,
    failure: { kind: "expired" },
  });
  const registration = {
    binding: next,
    roundId: f.parent.roundId,
    instanceVersion: f.registration.version,
    publicKey: f.grant.publicKey,
    methods: ["inspectCheckout"] as const,
  };
  const reopened = sessions.register(registration);
  expect(reopened?.keyId).not.toBe(f.grant.keyId);
  if (!reopened) throw Error("Missing reopened session");
  expect(reopened.principal.id).toBe(f.grant.principal.id);
  sessions.revoke(reopened);
  expect(sessions.register(registration)).toBeNull();
});

test("a stale attempt cannot read a successor checkout", async () => {
  using f = await fixture();
  const first = f.inspect();
  f.invoke(first);
  f.store.db.run(
    "UPDATE rounds SET data=json_set(data,'$.attempt.attemptId','successor') WHERE id=?",
    [f.parent.roundId],
  );
  expect(f.invoke(first)).toEqual({
    kind: "rejected",
    commandId: first.commandId,
    failure: { kind: "expired" },
  });
});

test("a shared directory reports shared", async () => {
  using f = await fixture();
  f.start();
  const original = f.inspect();
  expect(f.invoke(original)).toMatchObject({
    result: { checkout: { kind: "available", path: f.root, shared: true } },
  });
  f.store.db.run(
    "UPDATE threads SET data=json_set(data,'$.directory.generation','99') WHERE id=?",
    [f.parent.threadId],
  );
  for (const request of [original, f.inspect()]) {
    const result = f.invoke(request);
    expect(result).toMatchObject({ result: { checkout: { kind: "unavailable" } } });
    expect(JSON.stringify(result)).not.toContain(f.root);
  }
});

test("an executor cannot satisfy owner.decide", async () => {
  using f = await fixture();
  const decision = f.request("todo.decide", {
    threadId: f.parent.threadId,
    todoRequestId: "approval",
    decision: { kind: "approval", choiceKey: "allow", decision: "allow", scope: "once" },
  });
  expect(f.invoke(decision)).toEqual({
    kind: "rejected",
    commandId: decision.commandId,
    failure: { kind: "unsupported" },
  });
});

test("changing the instance version expires cached checkout receipts", async () => {
  using f = await fixture();
  const first = f.inspect();
  expect(f.invoke(first).kind).toBe("accepted");
  f.store.db.run("UPDATE executor_registrations SET data=json_set(data,'$.version','2')");
  expect(f.invoke(first)).toEqual({
    kind: "rejected",
    commandId: first.commandId,
    failure: { kind: "expired" },
  });
});

for (const stop of ["childSettled", "parentMessageCommitted", "returnCommitted"] as const) {
  test("resumes on the original parent round after " + stop, async () => {
    using f = await fixture();
    const child = f.start(),
      initial = f.store.services.childTransfers;
    const record = v.parse(DelegatedChildRecordSchema, {
      taskId: "task",
      parentThreadId: f.parent.threadId,
      parentRoundId: f.parent.roundId,
      childCommandId: "launch",
      childThreadId: child.threadId,
      childRoundId: child.roundId,
      instanceId: f.registration.instanceId,
      model: { id: "gpt-5.4", options: {} },
      requestedMode: "ask",
      effectiveMode: "ask",
      returnTransferId: "result",
      state: { kind: "queued" },
    });
    expect(initial.accept(record)).toBe("stored");
    expect(initial.pending()).toEqual([]);
    const completed = {
      ...record,
      state: { kind: "completed" as const, result: "the child's first result" },
    };
    const prepared = prepareChildResultTransfer(completed);
    if (prepared.kind !== "ok") throw Error("Expected pending transfer");
    const transfer = prepared.value;
    expect(await initial.settle({ ...record, state: { kind: "working" } }, transfer)).toBe(
      "conflict",
    );
    expect(await initial.readTransfer(transfer.id)).toBeNull();
    let firstMessage: { parentMessageId: string; returnedAt: number } | null = null;
    initial.afterCommit = (event) => {
      if (event.kind !== "childSettled")
        firstMessage = { parentMessageId: event.parentMessageId, returnedAt: event.returnedAt };
      if (event.kind === stop) throw Error("interrupt after " + stop);
    };
    await expect(
      (async () => {
        await initial.settle(completed, transfer);
        expect(
          await initial.markReturned(
            transfer.id,
            v.parse(MessageIdSchema, "invented"),
            100,
            transfer.version,
          ),
        ).toBe("conflict");
        await initial.returnToParent(transfer.id);
      })(),
    ).rejects.toThrow("interrupt after " + stop);
    f.close(f.store);
    const reopened = f.open(),
      worker = reopened.services.childTransfers;
    const saved = await worker.readTransfer(transfer.id);
    expect(saved).toMatchObject({ version: stop === "returnCommitted" ? "2" : "1" });
    expect(await worker.read(record.taskId)).toEqual(completed);
    const nextInput = f.request("input.send", {
      threadId: record.parentThreadId,
      content: { text: "new round", references: [], attachments: [] },
    });
    if (nextInput.method !== "input.send") throw Error("Expected input");
    const newer = applyInputCommand({
      actor: f.actor,
      transaction: reopened,
      command: {
        ...nextInput,
        signer: v.parse(RequestSignerSchema.options[0], {
          kind: "device",
          deviceId: "owner-device",
          keyId: "owner-key",
        }),
      },
    });
    if (newer.kind !== "accepted" || newer.result.kind !== "inputScheduled")
      throw Error("Expected new round");
    expect(newer.result.roundId).not.toBe(record.parentRoundId);
    const second = f.open();
    const results = await Promise.all([
      worker.returnToParent(transfer.id),
      second.services.childTransfers.returnToParent(transfer.id),
    ]);
    expect(results[1]).toEqual(results[0]);
    const winner = results[0];
    if (winner?.state.kind !== "returned") throw Error("Missing return");
    expect(winner).toMatchObject({ version: "2" });
    if (firstMessage) expect(winner.state).toMatchObject(firstMessage);
    expect(readMessage(reopened.db, winner.state.parentMessageId)).toMatchObject({
      roundId: record.parentRoundId,
      threadId: record.parentThreadId,
      text: completed.state.result,
    });
    expect(await worker.settle(completed, transfer)).toBe("unchanged");
    const changed = { ...completed, state: { kind: "completed" as const, result: "different" } };
    const alternative = prepareChildResultTransfer(changed);
    if (alternative.kind !== "ok") throw Error("Expected pending transfer");
    expect(await worker.settle(changed, alternative.value)).toBe("conflict");
    expect(
      await worker.markReturned(
        transfer.id,
        winner.state.parentMessageId,
        winner.state.returnedAt + 1,
        winner.version,
      ),
    ).toBe("conflict");
    expect(await worker.readTransfer(transfer.id)).toEqual(winner);
    expect(
      await worker.markReturned(
        transfer.id,
        winner.state.parentMessageId,
        winner.state.returnedAt,
        v.parse(ObjectVersionSchema, "42"),
      ),
    ).toBe("conflict");
    expect(
      reopened.db
        .query(
          "SELECT count(*) AS n FROM messages WHERE json_extract(data,'$.text')=? AND json_extract(data,'$.roundId')=?",
        )
        .get(completed.state.result, newer.result.roundId),
    ).toEqual({ n: 0 });
    expect(worker.pending()).toEqual([]);
    expect(
      reopened.db
        .query("SELECT count(*) AS n FROM messages WHERE json_extract(data,'$.text')=?")
        .get(completed.state.result),
    ).toEqual({ n: 1 });
  });
}

test("the replay peer installs private tools and reports each signed call's receipt", async () => {
  let wait = Promise.withResolvers<unknown>();
  const peer = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../../../tools/fixtures/executor-tool-peer.ts")],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "inherit",
      ipc(message) {
        wait.resolve(message);
      },
    },
  );
  async function exchange(message: unknown) {
    wait = Promise.withResolvers<unknown>();
    peer.send(message);
    return Promise.race([
      wait.promise,
      peer.exited.then((code) => {
        throw Error("Tool peer exited: " + code);
      }),
    ]);
  }
  try {
    using f = await fixture(async (attemptId, directory) => {
      const result = v.parse(
        v.object({
          kind: v.literal("opened"),
          attemptId: AttemptIdSchema,
          epoch: v.literal(1),
          nativeSessionId: NativeSessionIdSchema,
          publicKey: P256PublicKeySchema,
        }),
        await exchange({ kind: "open", attemptId, directory, model: "gpt-5.4" }),
      );
      expect(result.attemptId).toBe(attemptId);
      return result;
    });
    const { environmentId, connectionId, challengeId, challenge, signer } = f.inspect();
    const configuration = { environmentId, connectionId, challengeId, challenge, signer };
    expect(
      await exchange({ kind: "provideTools", tools: [{ name: "inspectCheckout", configuration }] }),
    ).toMatchObject({
      kind: "configured",
      attemptId: f.binding.attemptId,
      names: ["inspectCheckout"],
    });
    const foreign = f.start().threadId;
    let sequence = 0;
    for (const threadId of [f.parent.threadId, foreign, f.parent.threadId]) {
      const commandId = v.parse(CommandIdSchema, crypto.randomUUID());
      if (sequence === 2) f.store.services.executorTools.revoke(f.grant);
      const { request } = v.parse(
        v.object({ kind: v.literal("request"), request: SignedRequestSchema }),
        await exchange({
          kind: "callTool",
          name: "inspectCheckout",
          payload: { threadId },
          commandId,
        }),
      );
      const { signature, ...body } = request;
      expect(body).toMatchObject({
        ...configuration,
        commandId,
        sequence: ++sequence,
        method: "thread.inspectCheckout",
      });
      expect(await verifyP256(f.grant.publicKey, canonicalJson(body), signature)).toBe(true);
      const receipt = f.invoke(request);
      const completed = await exchange({ kind: "receipt", receipt });
      expect(completed).toEqual({
        kind: "completed",
        name: "inspectCheckout",
        attemptId: f.binding.attemptId,
        commandId,
        receipt,
      });
      if (sequence === 1)
        expect(receipt).toMatchObject({
          result: { checkout: { kind: "available", path: f.root, shared: true } },
        });
      else
        expect(receipt).toEqual({
          kind: "rejected",
          commandId,
          failure: { kind: sequence === 2 ? "notFound" : "expired" },
        });
    }
    peer.send({ kind: "close" });
    expect(await peer.exited).toBe(0);
  } finally {
    if (peer.exitCode === null && peer.signalCode === null) peer.kill();
    await peer.exited;
  }
});
