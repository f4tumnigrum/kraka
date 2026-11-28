// Live cases 6; required groups ["1.", "2.", "3.", "4.", "5.", "6."]
import { seedEffects, seedLegacy, pairRollbackReader } from "../fixtures/rollback-publications";
import { editRolledBackPrompt, rollbackEffectsLabel } from "../../packages/client-runtime/src";
import { openLocalInputs } from "../../packages/client-runtime/hosts/sqlite";
import { test, expect } from "bun:test";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { patchCase, finished } from "../fixtures/round-patch";
import { accepted } from "../fixtures/first-send";
import { git } from "../fixtures/isolated-start";
import { twoTurns, readPart, resume, settled, ledger } from "../fixtures/rollback";
import { readThread, openReceiptReader } from "@kraka/environment";

test(
  "1. preview rewind and edit the original prompt with its attachment",
  () =>
    patchCase(async (s) => {
      const seed = await twoTurns(s);
      await resume(s, false);
      const client = await s.rollbackReader(seed.threadId);
      writeFileSync(seed.file, "manual edit");
      expect(
        accepted(
          await client.rpc("checkpoint.previewRollback", { target: seed.target, mode: "dialogue" }),
          "rollbackPreview",
        ),
      ).toMatchObject({ rewind: "unknown", restoreFiles: false, maySubmit: false });
      expect(await ledger(s)).toEqual({ rewinds: 0, writes: 0 });
      await resume(s);
      const device = await s.rollbackReader(seed.threadId);
      expect(
        accepted(
          await device.rpc("checkpoint.previewRollback", { target: seed.target, mode: "dialogue" }),
          "rollbackPreview",
        ),
      ).toMatchObject({ rewind: "verified", restoreFiles: false, maySubmit: true });
      accepted(
        await device.rpc("checkpoint.rollbackDialogue", seed.target, seed.id),
        "checkpointRollback",
      );
      await settled(device, seed.id, "dialogue", "succeeded");
      const result = await readPart(device, seed, "dialogue");
      expect(result.draft).toMatchObject({
        text: "selected prompt",
        attachments: seed.attachments,
        references: [],
      });
      expect(result.progress.files).toEqual({ kind: "notRequested" });
      const local = openLocalInputs(join(s.dir, "editable.sqlite"));
      try {
        const scope = {
          principalId: s.pair.owner.principal.id,
          environmentId: s.f.instance.environmentId,
          threadId: seed.threadId,
        };
        const receipt = await device.rpc("checkpoint.readRollbackPart", {
          threadId: seed.threadId,
          operationId: seed.id,
          part: "dialogue",
        });
        const draft = await editRolledBackPrompt(local.outbox, scope, receipt);
        expect(draft?.content).toMatchObject({
          text: "selected prompt",
          attachments: seed.attachments,
        });
        await local.outbox.saveDraft(scope, "edited", draft!.content);
        expect((await local.outbox.inspect(scope)).drafts.current?.content.text).toBe("edited");
      } finally {
        local.close();
      }
      const history = await s.client.readInputHistory(seed.threadId);
      expect(history.rounds.find((r) => r.id === seed.round.id)).toMatchObject({
        rolledBackBy: seed.id,
        attempt: { phase: seed.round.attempt.phase },
      });
      expect(readFileSync(seed.file, "utf8")).toBe("manual edit");
      expect(await ledger(s)).toEqual({ rewinds: 1, writes: 0 });
    }),
  60000,
);

test(
  "2. shared checkout rejects both writes and an explicit retry restores the released directory",
  () =>
    patchCase(async (s) => {
      const seed = await twoTurns(s);
      await resume(s);
      const since = s.events.items.length;
      const other = accepted(
        (
          await s.client.send("thread.start", {
            ...s.f.payload,
            content: { text: "other work", attachments: [], references: [] },
          })
        ).receipt,
        "threadStarted",
      );
      const turn = await s.event("turn", since),
        reader = await s.patchReader(other.threadId);
      s.action(turn.handle, "finish");
      await finished(reader, other.roundId);
      const client = await s.rollbackReader(seed.threadId),
        legacy = await s.rollbackReader(seed.threadId, s.pair.owner, false);
      expect(await legacy.rpc("checkpoint.rollback", seed.target)).toMatchObject({
        kind: "rejected",
        failure: { kind: "unsupported" },
      });
      const index = git(s.f.cwd, "ls-files", "--stage"),
        head = git(s.f.cwd, "rev-parse", "HEAD"),
        branch = git(s.f.cwd, "symbolic-ref", "HEAD");
      const side = join(s.f.cwd, "other-work");
      writeFileSync(side, "other thread");
      writeFileSync(seed.file, "manual");
      accepted(await client.rpc("checkpoint.rollback", seed.target, seed.id), "checkpointRollback");
      const rejected = await readPart(client, seed, "files");
      expect(rejected.progress).toMatchObject({
        dialogue: { kind: "pending", execution: 1 },
        files: { kind: "failed", reason: "sharedWorkspace", retryable: true, execution: 1 },
      });
      expect([
        readFileSync(seed.file, "utf8"),
        readFileSync(side, "utf8"),
        git(s.f.cwd, "ls-files", "--stage"),
      ]).toEqual(["manual", "other thread", index]);
      expect(await ledger(s)).toEqual({ rewinds: 0, writes: 0 });
      const db = openReceiptReader(s.state);
      let baseVersion: string | undefined;
      try {
        baseVersion = readThread(db, other.threadId)?.version;
      } finally {
        db.close(true);
      }
      accepted(
        await client.rpc("thread.changeLifecycle", {
          threadId: other.threadId,
          baseVersion,
          change: { kind: "settle" },
        }),
        "threadChanged",
      );
      const retry = { threadId: seed.threadId, operationId: seed.id, expectedExecution: 1 };
      accepted(await client.rpc("checkpoint.retryFiles", retry), "checkpointRollback");
      await settled(client, seed.id, "files", "succeeded", 2);
      expect(await client.rpc("checkpoint.retryFiles", retry)).toMatchObject({
        kind: "rejected",
        failure: { kind: "invalidState" },
      });
      expect((await ledger(s)).rewinds).toBe(1);
      expect([
        readFileSync(seed.file, "utf8"),
        git(s.f.cwd, "rev-parse", "HEAD"),
        git(s.f.cwd, "symbolic-ref", "HEAD"),
      ]).toEqual(["first saved", head, branch]);
    }),
  60000,
);

test(
  "3. crash after durable dialogue success resumes the original file leg once",
  () =>
    patchCase(async (s, b) => {
      const seed = await twoTurns(s);
      writeFileSync(join(s.state, "hold-rollback"), "");
      writeFileSync(join(s.dir, "rewind-enabled"), "");
      await s.restart(false, b);
      accepted(
        (
          await s.client.send("executor.refresh", {
            projectId: s.f.project.id,
            instanceId: s.f.registration.instanceId,
          })
        ).receipt,
        "executorRefreshed",
      );
      const client = await s.rollbackReader(seed.threadId),
        observer = await s.rollbackReader(seed.threadId);
      const receipt = await client.rpc("checkpoint.rollback", seed.target, seed.id);
      accepted(receipt, "checkpointRollback");
      const fence = await b.events.until(
        (e) => e.stage === "dialogueCommitted" && e.id === seed.id,
      );
      expect(fence.round).toBe("1");
      expect((await readPart(observer, seed, "dialogue")).progress).toMatchObject({
        dialogue: { kind: "succeeded", execution: 1 },
        files: { kind: "pending", execution: 1 },
      });
      expect(await ledger(s)).toEqual({ rewinds: 1, writes: 0 });
      await s.restartRollback(true);
      const reconnected = await s.rollbackReader(seed.threadId);
      await settled(reconnected, seed.id, "files", "succeeded");
      expect((await readPart(reconnected, seed, "files")).progress.dialogue).toEqual({
        kind: "succeeded",
        execution: 1,
      });
      expect(await reconnected.rpc("checkpoint.rollback", seed.target, seed.id)).toEqual(receipt);
      expect(readFileSync(seed.file, "utf8")).toBe("first saved");
      expect(await ledger(s)).toEqual({ rewinds: 1, writes: 1 });
    }),
  60000,
);

test(
  "4. explicit retry after a file error leaves the successful rewind alone",
  () =>
    patchCase(async (s) => {
      const seed = await twoTurns(s);
      writeFileSync(join(s.state, "fail-rollback"), "");
      await resume(s);
      const client = await s.rollbackReader(seed.threadId);
      accepted(await client.rpc("checkpoint.rollback", seed.target, seed.id), "checkpointRollback");
      await settled(client, seed.id, "files", "failed");
      const first = await readPart(client, seed, "files");
      expect(first).toEqual(await readPart(client, seed, "files"));
      expect(first.progress).toMatchObject({
        dialogue: { kind: "succeeded", execution: 1 },
        files: { kind: "failed", execution: 1, reason: "fileIO", retryable: true },
      });
      expect(readFileSync(seed.file, "utf8")).toBe("second saved");
      unlinkSync(join(s.state, "fail-rollback"));
      accepted(
        await client.rpc("checkpoint.retryFiles", {
          threadId: seed.threadId,
          operationId: seed.id,
          expectedExecution: 1,
        }),
        "checkpointRollback",
      );
      await settled(client, seed.id, "files", "succeeded", 2);
      expect(readFileSync(seed.file, "utf8")).toBe("first saved");
      expect((await ledger(s)).rewinds).toBe(1);
    }),
  60000,
);

test(
  "5. confirmed publication evidence survives restore, retry and a narrower device reconnect",
  () =>
    patchCase(async (s) => {
      const seed = await twoTurns(s);
      const effects = seedEffects(s, seed);
      const viewer = await pairRollbackReader(s);
      writeFileSync(join(s.state, "fail-rollback"), "");
      await resume(s);
      const client = await s.rollbackReader(seed.threadId),
        narrow = await s.rollbackReader(seed.threadId, viewer);
      accepted(await client.rpc("checkpoint.rollback", seed.target, seed.id), "checkpointRollback");
      await settled(client, seed.id, "files", "failed");
      writeFileSync(seed.file, "edited after publication");
      for (const part of ["dialogue", "files"] as const) {
        expect((await readPart(client, seed, part)).progress.externalEffects).toEqual(effects);
        expect((await readPart(narrow, seed, part)).progress.externalEffects).toEqual([]);
      }
      unlinkSync(join(s.state, "fail-rollback"));
      const retry = accepted(
        await narrow.rpc("checkpoint.retryFiles", {
          threadId: seed.threadId,
          operationId: seed.id,
          expectedExecution: 1,
        }),
        "checkpointRollback",
      );
      expect(retry.progress.externalEffects).toEqual([]);
      await settled(client, seed.id, "files", "succeeded", 2);
      await s.restartRollback();
      const observer = await s.rollbackReader(seed.threadId),
        limited = await s.rollbackReader(seed.threadId, viewer);
      expect((await settled(observer, seed.id, "files", "succeeded", 2)).externalEffects).toEqual(
        effects,
      );
      expect((await settled(limited, seed.id, "files", "succeeded", 2)).externalEffects).toEqual(
        [],
      );
      expect((await s.rollbackFence()).publications).toBe(0);
    }),
  60000,
);

test(
  "6. an assessed empty range and unrecorded legacy effects remain distinct after restart",
  () =>
    patchCase(async (s) => {
      const seed = await twoTurns(s),
        old = seedLegacy(s, seed);
      await resume(s);
      const client = await s.rollbackReader(seed.threadId);
      accepted(
        await client.rpc("checkpoint.restoreFiles", seed.target, seed.id),
        "checkpointRollback",
      );
      await settled(client, seed.id, "files", "succeeded");
      async function inspect(reader: typeof client) {
        for (const part of ["dialogue", "files"] as const) {
          const fresh = (await readPart(reader, seed, part)).progress,
            legacy = (await readPart(reader, old, part)).progress;
          expect(fresh.externalEffects).toEqual([]);
          expect(rollbackEffectsLabel(legacy)).toBe("external effects not recorded");
          expect(Object.hasOwn(legacy, "externalEffects")).toBe(false);
        }
      }
      await inspect(client);
      await s.restartRollback();
      await inspect(await s.rollbackReader(seed.threadId));
      expect((await ledger(s)).rewinds).toBe(0);
      expect((await s.rollbackFence()).publications).toBe(0);
    }),
  60000,
);
