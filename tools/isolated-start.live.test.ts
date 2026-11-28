import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { CommandIdSchema, GitObjectIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import { join } from "node:path";
import { rmSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { accepted, waitFile, productRoot, startFirstSendFixture } from "./fixtures/first-send";
import { codexFixture } from "./fixtures/codex-turn";
import { withState } from "./fixtures/replay-process";
import {
  seedGit,
  git,
  isolatedFixture,
  idle,
  peer,
  readClaim,
  setupPolicy,
  cli,
} from "./fixtures/isolated-start";
import {
  openReceiptReader,
  transitionWorktree,
  saveManaged,
  readThread,
  readRound,
  managedView,
  hashId,
  type Managed,
} from "@kraka/environment";
const isolated = { kind: "isolated" as const, selection: null };
const marker = [
  process.execPath,
  "-e",
  'require("node:fs").appendFileSync("setup.log","setup\\n")',
];
function done(n: number) {
  console.log(`S14 case ${n} passed`);
}
function roundInfo(state: string, m: Managed) {
  const db = openReceiptReader(state);
  try {
    return {
      round: readRound(db, m.roundId),
      thread: readThread(db, m.claim.threadId),
      messages: db
        .query("SELECT id FROM messages WHERE json_extract(data,'$.threadId')=?")
        .all(m.claim.threadId).length,
      rounds: db
        .query("SELECT id FROM rounds WHERE json_extract(data,'$.threadId')=?")
        .all(m.claim.threadId).length,
    };
  } finally {
    db.close();
  }
}
test(
  "J-2.1 shared root and a new branch from the explicitly selected commit",
  () =>
    withState(async (dir) => {
      const { f, opts, repo } = await isolatedFixture(dir);
      try {
        const pick = {
          projectId: f.project.id,
          worktreeId: crypto.randomUUID(),
          branch: "feature/later",
          baseRef: "main",
        };
        const { receipt: selected } = await f.client.send("worktree.prepare", pick);
        expect(accepted(selected, "worktreeBaseSelected").commit.toString()).toBe(repo.base);
        const newer = repo.commit("second");
        expect((await f.client.send("worktree.prepare", pick, selected.commandId)).receipt).toEqual(
          selected,
        );
        const repeated = accepted(
          (await f.client.send("worktree.prepare", pick)).receipt,
          "worktreeBaseSelected",
        );
        expect(repeated).toEqual(accepted(selected, "worktreeBaseSelected"));
        expect(
          (await f.client.send("worktree.prepare", { ...pick, baseRef: repo.base })).receipt,
        ).toMatchObject({ failure: { kind: "idConflict" } });
        expect(git(repo.path, "worktree", "list", "--porcelain")).not.toContain(pick.branch);
        expect(
          (
            await f.client.send("worktree.prepare", {
              ...pick,
              worktreeId: crypto.randomUUID(),
              baseRef: "missing-ref",
            })
          ).receipt,
        ).toMatchObject({ kind: "rejected" });
        const shared = await cli(f, "shared", { kind: "shared" });
        setupPolicy(f, marker);
        const task = await cli(f, "isolated", {
          kind: "isolated",
          selection: { branch: "feature/task", baseRef: repo.base },
        });
        await idle(f);
        const id = task.request.payload.worktreeId;
        if (!id) throw Error("Missing isolated ID");
        const m = readClaim(opts.stateDir, id),
          path = m.directory.realPath;
        expect(managedView(m)).toMatchObject({
          availability: "usable",
          status: {
            projectId: f.project.id,
            threadId: task.ids.threadId,
            branch: "feature/task",
            phase: { kind: "ready", origin: { commit: repo.base } },
          },
        });
        expect(roundInfo(opts.stateDir, m).thread?.directory?.kind).toBe("managedWorktree");
        const db = openReceiptReader(opts.stateDir);
        try {
          expect(readThread(db, shared.ids.threadId)).toMatchObject({
            projectId: f.project.id,
            worktreeId: null,
            directory: { kind: "projectRoot" },
          });
        } finally {
          db.close();
        }
        expect(peer(opts.stateDir, shared.ids.deliveryId).cwd).toBe(repo.path);
        expect(peer(opts.stateDir, task.ids.deliveryId).cwd).toBe(path);
        expect(path).toBe(
          join(f.instance.stateDirectory, "worktrees", hashId(f.project.id), hashId(id)),
        );
        expect(git(path, "rev-parse", "HEAD")).toBe(repo.base);
        expect(git(repo.path, "rev-parse", "HEAD")).toBe(newer);
        expect(git(path, "branch", "--show-current")).toBe("feature/task");
        expect(git(repo.path, "branch", "--show-current")).toBe("main");
        expect(readFileSync(join(path, "setup.log"), "utf8")).toBe("setup\n");
        expect(existsSync(join(repo.path, "setup.log"))).toBe(false);
        const followup = accepted(
          (
            await f.client.send("input.send", {
              threadId: task.ids.threadId,
              content: f.payload.content,
            })
          ).receipt,
          "inputScheduled",
        );
        await idle(f);
        expect(peer(opts.stateDir, followup.deliveryId).cwd).toBe(path);
        const history = await f.client.readInputHistory(task.ids.threadId);
        expect(history.rounds.map((r) => r.id)).toEqual([task.ids.roundId, followup.roundId]);
        expect(history.rounds.at(-1)?.attempts?.[0]?.attemptId).toBe(followup.attemptId);
        console.log(repo.version);
        done(1);
      } finally {
        await f.close();
      }
    }),
  60000,
);
test(
  "S-WORK-006 a lost receipt reuses the original command, objects, base and directory",
  () =>
    withState(async (dir) => {
      const { f, repo, opts, restart } = await isolatedFixture(dir, "afterCommit");
      try {
        setupPolicy(f, marker, "feature");
        const lost = cli(f, "lost", isolated).then(
          () => false,
          () => true,
        );
        await waitFile(join(opts.stateDir, "entered-afterCommit"));
        const db = openReceiptReader(opts.stateDir);
        const recorded = (() => {
          try {
            return db.query<{ id: string }, []>("SELECT id FROM managed_worktrees").get();
          } finally {
            db.close();
          }
        })();
        if (!recorded) throw Error("No claim before reply");
        const before = readClaim(opts.stateDir, recorded.id),
          receipt = f.receipt(before.firstCommand);
        if (!receipt) throw Error("Missing accepted receipt");
        await f.kill();
        expect(await lost).toBe(true);
        repo.commit("advanced");
        setupPolicy(f, marker, "changed");
        const next = await restart();
        try {
          const retry = await cli(next, "lost", isolated);
          await idle(next);
          expect(retry.receipt).toEqual(receipt.receipt);
          expect(next.receipt(before.firstCommand)).toEqual(receipt);
          const after = readClaim(opts.stateDir, recorded.id);
          expect(after.claim.branch).toBe(before.claim.branch);
          expect(after.claim.branch).toStartWith("feature-");
          expect(after.directory).toEqual(before.directory);
          expect(managedView(after)).toMatchObject({
            availability: "usable",
            status: { phase: { kind: "ready", origin: { commit: repo.base } } },
          });
          expect(roundInfo(opts.stateDir, after)).toMatchObject({
            messages: 1,
            rounds: 1,
            round: {
              id: retry.ids.roundId,
              attempt: { attemptId: retry.ids.attemptId, deliveryId: retry.ids.deliveryId },
            },
          });
          expect(peer(opts.stateDir, retry.ids.deliveryId).cwd).toBe(after.directory.realPath);
          done(2);
        } finally {
          await next.close();
        }
      } finally {
        await f.close();
      }
    }),
  60000,
);
test(
  "S-THREAD-004 setup failure leaves the first round held at its original directory",
  () =>
    withState(async (dir) => {
      const { f, opts, repo, restart } = await isolatedFixture(dir, "beforeSetup");
      try {
        setupPolicy(f, [
          process.execPath,
          "-e",
          'process.exit(require("node:fs").existsSync("retry-ok")?0:7)',
        ]);
        const task = await cli(f, "failure", isolated),
          id = task.request.payload.worktreeId;
        if (!id) throw Error("Missing claim");
        await waitFile(join(opts.stateDir, "entered-beforeSetup"));
        const before = readClaim(opts.stateDir, id);
        expect(before.claim.phase).toMatchObject({
          kind: "preparing",
          script: { kind: "started" },
        });
        writeFileSync(join(opts.stateDir, "release-beforeSetup"), "go");
        await idle(f);
        const after = readClaim(opts.stateDir, id),
          target = {
            threadId: task.ids.threadId,
            projectId: f.project.id,
            worktreeId: id,
            branch: after.claim.branch,
            baseRef: null,
          };
        const status = accepted(
          (await f.client.send("worktree.prepare", target)).receipt,
          "worktreeStatus",
        );
        expect(status.view).toMatchObject({
          availability: "unavailable",
          status: {
            generation: "1",
            threadId: task.ids.threadId,
            phase: {
              kind: "preparing",
              script: { kind: "failed", reason: "workspace_preparation_failed: setup exited 7" },
            },
          },
        });
        expect(
          (await f.client.send("input.releaseQueue", { threadId: task.ids.threadId })).receipt,
        ).toMatchObject({ kind: "rejected", failure: { kind: "queueHeld" } });
        expect(after.directory).toEqual(before.directory);
        expect(roundInfo(opts.stateDir, after).round).toMatchObject({
          id: task.ids.roundId,
          place: "1",
          attempt: { phase: { kind: "filed", gate: "held" } },
        });
        expect(
          (
            await f.client.send("input.send", {
              threadId: task.ids.threadId,
              content: f.payload.content,
            })
          ).receipt,
        ).toMatchObject({
          kind: "rejected",
          failure: { kind: "worktreeRestoreFailed", reason: "setupFailed", view: status.view },
        });
        expect(f.receipt(task.receipt.commandId)?.receipt).toEqual(task.receipt);
        expect(readdirSync(opts.stateDir).filter((p) => p.startsWith("peer-"))).toHaveLength(0);
        const phase = after.claim.phase;
        if (phase.kind !== "preparing" || phase.script.kind !== "failed")
          throw Error("Missing failed attempt");
        writeFileSync(join(after.directory.realPath, "retry-ok"), "yes");
        const retry = await f.client.send("worktree.retrySetup", {
          projectId: f.project.id,
          worktreeId: id,
          threadId: task.ids.threadId,
          generation: after.claim.generation,
          previousAttemptId: phase.script.attemptId,
        });
        const newPhase = accepted(retry.receipt, "worktreeStatus").view.status.phase;
        expect(newPhase).toMatchObject({ kind: "preparing", script: { kind: "started" } });
        if (newPhase.kind !== "preparing" || newPhase.script.kind !== "started")
          throw Error("No retry identity");
        expect(newPhase.script.attemptId).not.toEqual(phase.script.attemptId);
        await idle(f);
        expect(peer(opts.stateDir, task.ids.deliveryId).cwd).toBe(after.directory.realPath);
        const ready = readClaim(opts.stateDir, id);
        await f.close();
        const op = v.parse(CommandIdSchema, crypto.randomUUID());
        const previousHead = v.parse(
          GitObjectIdSchema,
          git(after.directory.realPath, "rev-parse", "HEAD"),
        );
        rmSync(join(after.directory.realPath, "retry-ok"));
        const cleaning = transitionWorktree(ready.claim, {
          kind: "clean",
          operationId: op,
          generation: ready.claim.generation,
          inspection: {
            kind: "inspected",
            head: previousHead,
            occupied: false,
            staged: [],
            unstaged: [],
            untracked: [],
            ignored: [],
            publication: "published",
          },
        });
        if (cleaning.kind !== "ok") throw Error("Fixture could not retire checkout");
        git(repo.path, "worktree", "remove", after.directory.realPath);
        const removed = transitionWorktree(cleaning.value, {
          kind: "removed",
          operationId: op,
          generation: ready.claim.generation,
        });
        if (removed.kind !== "ok") throw Error("Fixture has no absent claim");
        const writer = new Database(join(opts.stateDir, "environment.sqlite"));
        try {
          saveManaged(writer, {
            ...ready,
            claim: { ...removed.value, settings: ready.claim.settings },
          });
        } finally {
          writer.close();
        }
        const next = await restart();
        try {
          const send = { threadId: task.ids.threadId, content: f.payload.content };
          const restored = await next.client.send("input.send", send);
          expect(restored.receipt).toMatchObject({
            kind: "rejected",
            commandId: restored.request.commandId,
            failure: {
              kind: "worktreeRestoreFailed",
              reason: "setupFailed",
              generation: "2",
              view: {
                status: {
                  operationId: restored.request.commandId,
                  phase: {
                    kind: "preparing",
                    origin: {
                      kind: "localBranch",
                      prior: { kind: "rebuild", previousHead, oldFiles: "notRestored" },
                    },
                    script: { kind: "failed" },
                  },
                },
              },
            },
          });
          expect(
            (await next.client.send("input.send", send, restored.request.commandId)).receipt,
          ).toEqual(restored.receipt);
          expect(next.receipt(task.receipt.commandId)?.receipt).toEqual(task.receipt);
          expect(roundInfo(opts.stateDir, readClaim(opts.stateDir, id)).rounds).toBe(1);
          expect(readdirSync(opts.stateDir).filter((p) => p.startsWith("peer-"))).toHaveLength(1);
        } finally {
          await next.close();
        }
        done(3);
      } finally {
        writeFileSync(join(opts.stateDir, "release-beforeSetup"), "go");
        await f.close();
      }
    }),
  60000,
);
test("restart at claim, Git registration and setup boundaries preserves the other checkout", async () => {
  for (const point of ["claimed", "registered", "beforeSetup", "setupExited"] as const)
    await withState(async (dir) => {
      const { f, opts, repo, restart } = await isolatedFixture(dir, point);
      try {
        setupPolicy(f, marker);
        writeFileSync(join(repo.path, "other.txt"), "untouched");
        const task = await cli(f, "kill", isolated),
          id = task.request.payload.worktreeId;
        if (!id) throw Error("Missing claim");
        await waitFile(join(opts.stateDir, `entered-${point}`));
        const before = readClaim(opts.stateDir, id);
        expect(String(before.claim.generation)).toBe("1");
        if (point === "registered") {
          expect(before.active?.process ?? null).toEqual(before.claim.gitChild);
          expect(before.claim.gitChild?.pid).toBeGreaterThan(0);
          expect(before.claim.gitChild?.startedAt).toBeGreaterThan(0);
        }
        await f.kill();
        writeFileSync(join(opts.stateDir, `release-${point}`), "release");
        const next = await restart();
        try {
          await idle(next);
          const m = readClaim(opts.stateDir, id),
            view = managedView(m);
          expect(next.receipt(task.receipt.commandId)?.receipt).toEqual(task.receipt);
          const listed = git(repo.path, "worktree", "list", "--porcelain");
          expect(listed).toContain(`branch refs/heads/${m.claim.branch}`);
          expect(readFileSync(join(repo.path, "other.txt"), "utf8")).toBe("untouched");
          const peers = readdirSync(opts.stateDir).filter((p) => p.startsWith("peer-"));
          if (point === "beforeSetup") {
            expect(view).toMatchObject({
              availability: "needsInspection",
              status: { phase: { kind: "preparing", script: { kind: "unknown" } } },
            });
            expect(peers).toHaveLength(0);
            expect(existsSync(join(m.directory.realPath, "setup.log"))).toBe(false);
          } else {
            expect(view.availability).toBe("usable");
            expect(peer(opts.stateDir, task.ids.deliveryId).cwd).toBe(m.directory.realPath);
            expect(peers).toHaveLength(1);
            expect(readFileSync(join(m.directory.realPath, "setup.log"), "utf8")).toBe("setup\n");
          }
        } finally {
          await next.close();
        }
      } finally {
        writeFileSync(join(opts.stateDir, `release-${point}`), "go");
        await f.close();
      }
    });
  done(4);
}, 180000);

test(
  "the standalone daemon re-executes itself for Git and setup",
  () =>
    withState(async (dir) => {
      const repo = seedGit(dir);
      const executable = join(dir, process.platform === "win32" ? "kraka.exe" : "kraka");
      const build = Bun.spawnSync(
        [
          process.execPath,
          "build",
          "--compile",
          join(productRoot, "packages/daemon/src/index.ts"),
          "--outfile",
          executable,
        ],
        { cwd: dir, timeout: 60000 },
      );
      if (build.exitCode !== 0) throw Error(build.stderr.toString());
      const stateDir = join(dir, "state");
      const writer = await startFirstSendFixture({
        stateDir,
        projectDirectory: repo.path,
        adapter: "replay",
        executable,
      });
      try {
        setupPolicy(writer, ["git", "config", "--file", "setup.cfg", "kraka.setup", "completed"]);
        const task = await cli(writer, "standalone", isolated);
        const id = task.request.payload.worktreeId;
        if (!id) throw Error("Expected standalone checkout");
        await idle(writer);
        const m = readClaim(stateDir, id);
        expect(managedView(m).availability).toBe("usable");
        expect(
          git(m.directory.realPath, "config", "--file", "setup.cfg", "--get", "kraka.setup"),
        ).toBe("completed");
        expect(git(m.directory.realPath, "rev-parse", "HEAD")).toBe(repo.base);
        expect(roundInfo(stateDir, m).round?.attempt.phase.kind).toBe("finished");
      } finally {
        await writer.close();
      }
    }),
  90000,
);

test(
  "the configured Codex peer opens the isolated checkout after preparation",
  () =>
    withState(async (dir) => {
      seedGit(dir, "project");
      const f = await codexFixture(dir);
      try {
        accepted((await f.configure()).receipt, "executorConfigured");
        accepted((await f.refresh()).receipt, "executorRefreshed");
        const id = crypto.randomUUID();
        const first = accepted(
          (await f.client.send("thread.start", { ...f.payload, worktreeId: id })).receipt,
          "threadStarted",
        );
        await f.waitTerminal();
        const managed = readClaim(f.stateDir, id);
        expect(managedView(managed).availability).toBe("usable");
        expect(f.updates.at(-1)?.kind).toBe("round.ended");
        expect(f.ledger.rows()).toContainEqual(
          expect.objectContaining({ event: "spawn", cwd: managed.directory.realPath }),
        );
        expect(f.ledger.rows().filter((r) => r.event === "turn/start" && r.hasInput)).toMatchObject(
          [{ clientId: first.deliveryId }],
        );
      } finally {
        await f.close();
      }
    }),
  60000,
);
