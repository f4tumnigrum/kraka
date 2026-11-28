import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandIdSchema,
  HostInstanceIdSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  RoundPhaseSchema,
  HandoffContextSchema,
  NativeSessionIdSchema,
  ExecutorInstanceIdSchema,
} from "@kraka/protocol";
import { openWriter, confirmWriter } from "./writer";
import { openStore, readReceipt, readThread, readRound, readMessage } from "./first-send-store";
import { acceptFirstInput, registerProject } from "./first-send";

async function withWriter(run: (f: Awaited<ReturnType<typeof create>>) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "kraka-first-"));
  try {
    const f = await create(dir);
    try {
      await run(f);
    } finally {
      f.stop();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
}
async function create(dir: string) {
  const locked = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 1000,
  );
  if (locked.kind !== "writer") throw new Error(locked.kind);
  let store: ReturnType<typeof openStore>;
  try {
    store = openStore(locked.lease);
  } catch (e) {
    locked.close();
    throw e;
  }
  const actor = {
    environmentId: locked.lease.environmentId,
    id: v.parse(PrincipalIdSchema, "owner"),
    allows: () => true,
  };
  const path = join(dir, "project");
  mkdirSync(path, { recursive: true });
  const reg = registerProject({
    transaction: store,
    actor,
    commandId: v.parse(CommandIdSchema, crypto.randomUUID()),
    environmentId: actor.environmentId,
    realPath: path,
  });
  if (reg.kind !== "accepted" || reg.result.kind !== "projectRegistered")
    throw new Error("Missing project");
  const payload = v.parse(REQUEST_METHODS.startThread.schema.entries.payload, {
    projectId: reg.result.project.id,
    worktreeId: null,
    content: { text: "hello", references: [], attachments: [] },
  });
  const commandId = v.parse(CommandIdSchema, "first");
  const input = { transaction: store, verifiedActor: actor, commandId, threadStart: payload };
  let closed = false;
  return {
    dir,
    path,
    input,
    store,
    locked,
    actor,
    stop() {
      if (!closed) {
        closed = true;
        store.db.close();
        locked.close();
      }
    },
  };
}
test("opening a fresh writer commits its complete schema and initial rows once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kraka-fresh-store-"));
  try {
    const lock = await openWriter(
      dir,
      v.parse(HostInstanceIdSchema, crypto.randomUUID()),
      performance.now() + 1000,
    );
    if (lock.kind !== "writer") throw Error(lock.kind);
    try {
      const store = openStore(lock.lease);
      try {
        expect(store.db.query("PRAGMA user_version").get()).toEqual({ user_version: 2 });
        expect(store.db.query("SELECT head FROM sync_meta").get()).toEqual({ head: "0" });
        expect(store.db.query("SELECT version FROM setting_version").get()).toEqual({
          version: "0",
        });
        // SQLite marks the last WAL frame of each committed transaction with a nonzero database size.
        // This fresh WAL has never been reset. Read it while the original connection is still open.
        const wal = readFileSync(join(dir, "environment.sqlite-wal"));
        const frameBytes = 24 + wal.readUInt32BE(8);
        expect((wal.length - 32) % frameBytes).toBe(0);
        let commits = 0;
        for (let frame = 32; frame < wal.length; frame += frameBytes)
          if (wal.readUInt32BE(frame + 4) !== 0) commits++;
        expect(commits).toBe(1);
        expect(store.db.query("SELECT count(*) AS n FROM executor_registrations").get()).toEqual({
          n: 0,
        });
      } finally {
        store.db.close(true);
      }
    } finally {
      lock.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});
test("a lost reply can be read after restart; a changed intent or revoked grant cannot reuse it", () =>
  withWriter(async (f) => {
    const receipt = acceptFirstInput(f.input);
    const record = readReceipt(f.store.db, f.actor.id, f.input.commandId);
    f.stop();
    const again = await create(f.dir);
    try {
      expect(acceptFirstInput(again.input)).toEqual(receipt);
      expect(readReceipt(again.store.db, again.actor.id, again.input.commandId)).toEqual(record);
      expect(
        acceptFirstInput({
          ...again.input,
          threadStart: {
            ...again.input.threadStart,
            content: { ...again.input.threadStart.content, text: "changed" },
          },
        }),
      ).toMatchObject({ failure: { kind: "idConflict" } });
      expect(
        acceptFirstInput({
          ...again.input,
          verifiedActor: { ...again.actor, allows: () => false },
        }),
      ).toMatchObject({ failure: { kind: "missingPermission" } });
    } finally {
      again.stop();
    }
  }));
test("old publications cannot confirm an endpoint; future storage stays unopened", () =>
  withWriter(async (f) => {
    f.locked.publish("ws://127.0.0.1:1/commands");
    expect(await confirmWriter(realpathSync.native(f.dir), performance.now() + 100)).toBeNull();
    f.store.db.run("UPDATE header SET data=?", [JSON.stringify({ format: 99, ledger: [] })]);
    f.stop();
    await expect(create(f.dir)).rejects.toThrow("futureFormat");
  }));
test("replacing a project root keeps the historical thread readable and prevents dispatch", () =>
  withWriter(async (f) => {
    const receipt = acceptFirstInput(f.input);
    if (receipt.kind !== "accepted" || receipt.result.kind !== "threadStarted")
      throw new Error("Missing thread");
    const thread = readThread(f.store.db, receipt.result.threadId);
    if (!thread) throw new Error("Missing thread");
    renameSync(f.path, `${f.path}-old`);
    mkdirSync(f.path);
    expect(f.store.directory(thread)).toBeNull();
    const { directory, ...legacy } = thread;
    f.store.db.run("UPDATE threads SET data=? WHERE id=?", [JSON.stringify(legacy), thread.id]);
    const old = readThread(f.store.db, thread.id);
    expect(old?.title).toBe("hello");
    expect(old && f.store.directory(old)).toBeNull();
    expect(acceptFirstInput(f.input)).toEqual(receipt);
    expect(
      acceptFirstInput({ ...f.input, commandId: v.parse(CommandIdSchema, "new") }),
    ).toMatchObject({ failure: { kind: "invalidState" } });
  }));
test("round end times and frozen partial history survive restart, including a legacy unknown source", () =>
  withWriter(async (f) => {
    const accepted = acceptFirstInput(f.input);
    if (accepted.kind !== "accepted" || accepted.result.kind !== "threadStarted")
      throw new Error("Missing thread");
    const ids = accepted.result;
    const round = readRound(f.store.db, ids.roundId),
      message = readMessage(f.store.db, ids.messageId);
    if (!round || !message) throw new Error("Missing input");
    const phase = v.parse(RoundPhaseSchema, {
      kind: "endedEarly",
      reason: "stopped",
      root: { id: "root", sessionId: "native", beganAt: 1 },
      receipt: null,
      endedAt: 99,
      endTimeEvidence: {
        source: "executorReported",
        executorEndedAt: 99,
        environmentObservedAt: 105,
      },
    });
    f.store.setPhase(round, phase);
    const handoff = v.parse(HandoffContextSchema, {
      transferId: "transfer",
      source: {
        environmentId: f.actor.environmentId,
        threadId: ids.threadId,
        roundId: ids.roundId,
      },
      messageIds: ["later", "earlier"],
      history: {
        coverage: "partial",
        missingSources: [
          {
            kind: "missingRound",
            environmentId: f.actor.environmentId,
            threadId: "old",
            roundId: "old-round",
          },
        ],
        omittedItems: 3,
      },
    });
    const frozen = {
      deliveryId: ids.deliveryId,
      attemptId: ids.attemptId,
      target: {
        family: "replay" as const,
        instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
        nativeSessionId: v.parse(NativeSessionIdSchema, "native"),
        epoch: 1,
      },
      messageVersion: message.version,
      input: { id: message.id, ...f.input.threadStart.content },
      parts: [],
      handoff,
    };
    expect(f.store.freeze(frozen)).toBe("stored");
    f.store.db.run("UPDATE messages SET data=? WHERE id=?", [
      JSON.stringify({ ...message, text: "later edit" }),
      message.id,
    ]);
    f.stop();
    const next = await create(f.dir);
    try {
      expect(next.store.frozen(ids.deliveryId)).toEqual(frozen);
      expect(
        next.store.freeze({ ...frozen, parts: [], handoff: { ...handoff, messageIds: [] } }),
      ).toBe("conflict");
      expect(readRound(next.store.db, ids.roundId)?.attempt.phase).toEqual(phase);
      if (!("endedAt" in phase)) throw new Error("Expected end evidence");
      const { endTimeEvidence, ...legacy } = phase;
      next.store.db.run("UPDATE rounds SET data=? WHERE id=?", [
        JSON.stringify({ ...round, attempt: { ...round.attempt, phase: legacy } }),
        ids.roundId,
      ]);
    } finally {
      next.stop();
    }
    const legacy = await create(f.dir);
    try {
      expect(readRound(legacy.store.db, ids.roundId)?.attempt.phase).toMatchObject({
        endedAt: 99,
        endTimeEvidence: { source: "unknown", executorEndedAt: null, environmentObservedAt: null },
      });
    } finally {
      legacy.stop();
    }
  }));
