import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import * as v from "valibot";
import {
  CheckpointCaptureSchema,
  CommandIdSchema,
  DeviceIdSchema,
  HostInstanceIdSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  RoundPhaseSchema,
  RollbackTargetSchema,
  type RollbackProgress,
} from "@kraka/protocol";
import { openWriter } from "./writer";
import { openStore, readThread, readRound } from "./first-send-store";
import { acceptFirstInput, registerProject } from "./first-send";
import { beginRollback } from "./checkpoints";
import type { RollbackOperation } from "./rollback-store";
async function fixture(run: (f: Awaited<ReturnType<typeof setup>>) => void) {
  const dir = mkdtempSync(join(tmpdir(), "rollback-store-"));
  try {
    const f = await setup(dir);
    try {
      run(f);
    } finally {
      f.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
async function setup(dir: string) {
  const lock = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 1000,
  );
  assert.equal(lock.kind, "writer");
  let store = openStore(lock.lease);
  const actor = {
    environmentId: lock.lease.environmentId,
    id: v.parse(PrincipalIdSchema, "actor"),
    device: v.parse(DeviceIdSchema, "device"),
    allows: () => true,
  };
  const path = join(dir, "repo");
  mkdirSync(path);
  const file = join(path, "target");
  writeFileSync(file, "original");
  const id = () => v.parse(CommandIdSchema, crypto.randomUUID());
  const project = registerProject({
    transaction: store,
    actor,
    commandId: id(),
    environmentId: actor.environmentId,
    realPath: path,
  });
  assert.ok(project.kind === "accepted" && project.result.kind === "projectRegistered");
  const threadStart = v.parse(REQUEST_METHODS.startThread.schema.entries.payload, {
    projectId: project.result.project.id,
    worktreeId: null,
    content: { text: "go", references: [], attachments: [] },
  });
  const start = () =>
    acceptFirstInput({ transaction: store, verifiedActor: actor, commandId: id(), threadStart });
  const receipt = start();
  assert.ok(receipt.kind === "accepted" && receipt.result.kind === "threadStarted");
  const { threadId, roundId, attemptId } = receipt.result,
    thread = readThread(store.db, threadId),
    round = readRound(store.db, roundId);
  assert.ok(thread?.directory?.kind === "projectRoot" && round);
  const { directoryId, generation } = thread.directory,
    capture = v.parse(CheckpointCaptureSchema, {
      id: "capture",
      roundId,
      attemptId,
      version: "1",
      result: {
        kind: "ready",
        directoryId,
        generation,
        comparison: { before: "a".repeat(40), after: "b".repeat(40), summary: { kind: "empty" } },
      },
    });
  const phase = v.parse(RoundPhaseSchema, {
    kind: "finished",
    root: { sessionId: "session", id: "root", beganAt: 1 },
    endedAt: 2,
    receipt: null,
    captureId: capture.id,
  });
  store.setPhase(round, phase, capture);
  const target = v.parse(RollbackTargetSchema, {
    threadId,
    roundId,
    attemptId,
    captureId: capture.id,
    boundary: "before",
    directoryId,
    generation,
  });
  const commandId = id(),
    request = { method: "checkpoint.restoreFiles", commandId, payload: target } as const;
  const op: RollbackOperation = {
    actor: actor.id,
    device: actor.device,
    rounds: [roundId],
    native: null,
    binding: thread.directory,
    progress: beginRollback(commandId, target, "both"),
  };
  const progress = () => {
    const value = store.services.rollbacks.read(commandId);
    assert.ok(value);
    return value.progress;
  };
  return {
    commandId,
    op,
    actor,
    file,
    request,
    target,
    capture,
    threadId,
    start,
    id,
    round,
    get store() {
      return store;
    },
    progress,
    reopen() {
      store.db.close(true);
      store = openStore(lock.lease);
      return progress();
    },
    close() {
      store.db.close(true);
      lock.close();
    },
    insert() {
      store.db.transaction(() => store.services.rollbacks.save(op))();
    },
    begin() {
      return store.services.rollbacks.startRollback({
        actor,
        request: v.parse(REQUEST_METHODS.restoreFiles.schema, {
          ...request,
          kind: "signedRequest",
          protocolVersion: { major: 1, minor: 0 },
          environmentId: actor.environmentId,
          connectionId: "c",
          challengeId: "h",
          challenge: "A".repeat(43),
          signer: { kind: "device", deviceId: actor.device, keyId: "k" },
          sequence: 1,
          signature: "B".repeat(86),
        }),
      });
    },
  };
}
test("a retry reads the original operation", () =>
  fixture((f) => {
    f.start();
    const receipt = f.begin();
    expect(f.begin()).toEqual(receipt);
    expect(f.reopen().files).toMatchObject({
      kind: "failed",
      execution: 1,
      reason: "sharedWorkspace",
    });
    const command = {
      method: "checkpoint.retryFiles",
      commandId: f.id(),
      payload: { threadId: f.threadId, operationId: f.commandId, expectedExecution: 1 },
    } as const;
    const request = v.parse(REQUEST_METHODS.retryRollbackFiles.schema, {
      ...command,
      kind: "signedRequest",
      protocolVersion: { major: 1, minor: 0 },
      environmentId: f.actor.environmentId,
      connectionId: "c",
      challengeId: "h",
      challenge: "A".repeat(43),
      signer: { kind: "device", deviceId: f.actor.device, keyId: "k" },
      sequence: 2,
      signature: "B".repeat(86),
    });
    const retry = f.store.services.rollbacks.retry(f.actor, request);
    expect(retry.kind).toBe("accepted");
    expect(f.store.services.rollbacks.retry(f.actor, request)).toEqual(retry);
    expect(f.reopen()).toMatchObject({
      commandId: f.commandId,
      files: { kind: "pending", execution: 2 },
    });
    expect(f.begin()).toEqual(receipt);
  }));
test("a completed dialogue leg never runs twice", () =>
  fixture((f) => {
    f.insert();
    const ticket = { commandId: f.commandId, part: "dialogue", execution: 1 } as const;
    const report = (kind: "claim" | "succeeded" | "retry") =>
      f.store.services.rollbacks.report(f.op, { ...ticket, kind });
    expect(report("claim")?.progress.dialogue.kind).toBe("running");
    expect(report("succeeded")?.progress.dialogue.kind).toBe("succeeded");
    f.reopen();
    expect(report("claim")).toBeNull();
    expect(report("retry")).toBeNull();
    expect(f.reopen().dialogue).toEqual({ kind: "succeeded", execution: 1 });
  }));
test("a shared directory leaves files unchanged", () =>
  fixture((f) => {
    f.start();
    f.begin();
    expect(f.progress().files).toMatchObject({
      kind: "failed",
      execution: 1,
      reason: "sharedWorkspace",
      retryable: true,
    });
    expect(f.reopen().dialogue).toEqual({ kind: "notRequested" });
    expect(readFileSync(f.file, "utf8")).toBe("original");
  }));
test("a stale capture cannot claim file restore", () =>
  fixture((f) => {
    f.begin();
    const wrong = v.parse(CheckpointCaptureSchema, { ...f.capture, id: "other" });
    const result = f.store.services.rollbacks.report(
      { ...f.op, progress: f.progress() },
      {
        commandId: f.commandId,
        part: "files",
        kind: "claim",
        execution: 1,
        capture: wrong,
        exclusive: true,
      },
    );
    expect(result).toBeNull();
    expect(f.reopen().files).toEqual({ kind: "pending", execution: 1 });
  }));
test("a changed attempt cannot settle a rollback", () =>
  fixture((f) => {
    f.begin();
    const op = { ...f.op, progress: f.progress() };
    expect(
      f.store.services.rollbacks.report(op, {
        commandId: f.commandId,
        part: "files",
        kind: "claim",
        execution: 1,
        capture: f.capture,
        exclusive: true,
      })?.progress.files.kind,
    ).toBe("running");
    f.store.db.run(
      "UPDATE rounds SET data=json_set(data,'$.attempt.attemptId','replacement') WHERE id=?",
      [f.round.id],
    );
    expect(
      f.store.services.rollbacks.report(op, {
        commandId: f.commandId,
        part: "files",
        kind: "succeeded",
        execution: 1,
      }),
    ).toBeNull();
    expect(f.reopen().files).toEqual({ kind: "running", execution: 1 });
  }));
