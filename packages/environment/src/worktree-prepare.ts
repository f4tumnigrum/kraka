import { mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";
import {
  AttemptIdSchema,
  WorktreeGenerationSchema,
  type SignedRequest,
  type CommandReceipt,
} from "@kraka/protocol";
import { readRound, readThread, type FirstSendStore } from "./first-send-store";
import { type CommandContext, checkCommand, record, reject } from "./command-receipts";
import { REQUEST_METHODS } from "@kraka/protocol";
import { managedView } from "./worktree-git";
import {
  exists,
  gitRead,
  gitText,
  matches,
  observe,
  ownerRef,
  rebuildSource,
} from "./worktree-git";
import { readManaged, saveManaged, type Managed } from "./worktree-storage";
import { physicalDirectory } from "./project-directory";
import { reconcileWorktree, transitionWorktree, type WorktreeEvent } from "./worktrees";
import { checkoutLease, runWriter, waitForOriginal, forgetOutcome } from "./worktree-runner";
export type PreparationPoint = "claimed" | "registered" | "beforeSetup" | "setupExited";
export type PreparationHook = (point: PreparationPoint, claim: Managed) => void;
type Event = WorktreeEvent extends infer E
  ? E extends WorktreeEvent
    ? Omit<E, "operationId" | "generation">
    : never
  : never;
function apply(m: Managed, event: Event, operationId = m.claim.operationId) {
  const next = transitionWorktree(m.claim, {
    ...event,
    generation: m.claim.generation,
    operationId,
  });
  if (next.kind !== "ok") throw Error("Stale worktree transition");
  m.claim = { ...next.value, settings: m.claim.settings };
}
function ownDirectory(path: string, allowExisting: boolean) {
  if (!exists(path)) mkdirSync(path, { mode: 0o700 });
  else if (!allowExisting) throw Error("Occupied directory");
  const dir = physicalDirectory(path);
  if (dir?.realPath !== path) throw Error("Replaced directory");
  return dir;
}
export async function prepareClaim({
  claim: m,
  transaction,
  hook,
  retry,
}: {
  claim: Managed;
  transaction: FirstSendStore;
  hook?: PreparationHook | undefined;
  retry?: boolean;
}) {
  const { db, writer } = transaction,
    state = writer.stateDirectory,
    path = m.directory.realPath,
    repo = m.root.realPath;
  let lease: ReturnType<typeof checkoutLease> | undefined;
  const acquire = () => checkoutLease(state, m.directory.binding.directoryId);
  const persist = () => saveManaged(db, m);
  const change = (event: Event) => {
    apply(m, event);
    persist();
  };
  const ready = (event: Event) =>
    db.transaction(() => {
      const current = readManaged(db, m.claim.worktreeId);
      if (
        !current ||
        current.claim.generation !== m.claim.generation ||
        current.claim.operationId !== m.claim.operationId
      )
        throw Error("Replaced generation");
      change(event);
      const round = readRound(db, m.roundId),
        thread = readThread(db, m.claim.threadId);
      if (
        m.claim.operationId === m.firstCommand &&
        round?.attempt.phase.kind === "filed" &&
        round.attempt.phase.gate === "held" &&
        thread &&
        transaction.directory(thread)
      ) {
        transaction.setPhase(round, { kind: "filed", gate: "eligible" });
        db.run("INSERT INTO ready_dispatch VALUES(?,?,?)", [
          round.id,
          m.claim.worktreeId,
          m.claim.generation,
        ]);
      }
    })();
  async function execute(
    kind: "git" | "setup",
    cwd: string,
    argv: string[],
    input: Buffer = Buffer.alloc(0),
    after?: PreparationPoint,
  ) {
    if (
      !matches(m.root) ||
      !matches(m.common) ||
      !m.parent ||
      !matches(m.parent) ||
      (m.disk && !matches(m.disk))
    )
      throw Error("Directory changed");
    lease?.close();
    lease = undefined;
    const r = await runWriter(
      state,
      m.directory.binding.directoryId,
      kind,
      cwd,
      argv,
      input,
      (active) => {
        m.active = active;
        if (kind === "git") apply(m, { kind: "gitStarted", process: active.process });
        persist();
      },
    );
    lease = acquire();
    if (after) hook?.(after, m);
    if (kind === "git") apply(m, { kind: "gitExited", process: r.active.process });
    m.active = null;
    persist();
    forgetOutcome(state, r.active.token);
    if (kind === "git" && r.code !== 0) throw Error(`Git exited ${r.code}`);
    return r.code;
  }
  try {
    if (m.inspection || m.claim.phase.kind === "ready") return;
    if (m.active) {
      const active = m.active,
        code = await waitForOriginal(state, active);
      if (code === null) throw Error("Unconfirmed writer");
      lease = acquire();
      if (active.kind === "git") apply(m, { kind: "gitExited", process: active.process });
      m.active = null;
      persist();
      forgetOutcome(state, active.token);
      if (active.kind === "git" && code !== 0) throw Error("Git failed");
      const phase = m.claim.phase;
      if (
        active.kind === "setup" &&
        phase.kind === "preparing" &&
        phase.script.kind === "started"
      ) {
        if (reconcileWorktree(m.claim, observe(m)).action === "inspect")
          throw Error("Checkout changed");
        if (code === 0) ready({ kind: "setupPassed", attemptId: phase.script.attemptId });
        else
          change({
            kind: "setupFailed",
            attemptId: phase.script.attemptId,
            reason: `workspace_preparation_failed: setup exited ${code}`,
          });
        return;
      }
    }
    lease ??= acquire();
    if (m.claim.phase.kind === "building") {
      const origin = m.claim.phase.origin;
      if (origin.kind === "empty") throw Error("No pinned commit");
      hook?.("claimed", m);
      if (!m.parent) {
        const parent = dirname(path);
        ownDirectory(dirname(parent), true);
        m.parent = ownDirectory(parent, true);
        persist();
      }
      const seen = observe(m),
        action = reconcileWorktree(m.claim, seen).action;
      if (
        !["build", "registerCheckout", "recordVerified", "repairUnpublishedCheckout"].includes(
          action,
        )
      )
        throw Error("Ownership unconfirmed");
      if (seen.branch === "absent") {
        const refs = `create refs/heads/${m.claim.branch} ${origin.commit}\ncreate ${ownerRef(m)} ${origin.commit}\n`;
        await execute("git", repo, ["git", "update-ref", "--stdin"], Buffer.from(refs));
      }
      if (observe(m).branch !== "expected") throw Error("Unexpected ref");
      m.branchOwned = true;
      persist();
      if (!m.disk) {
        m.disk = ownDirectory(path, false);
        persist();
      }
      if (seen.registration === "absent") {
        if (readdirSync(path).length) throw Error("Occupied checkout");
        await execute(
          "git",
          repo,
          ["git", "worktree", "add", "--no-checkout", "--", path, m.claim.branch],
          Buffer.alloc(0),
          "registered",
        );
      }
      if (observe(m).registration !== "owned") throw Error("Unverified registration");
      m.admin = physicalDirectory(gitText(path, "rev-parse", "--absolute-git-dir"));
      persist();
      if (observe(m).disk !== "verifiedCheckout") {
        if (
          gitRead(path, "diff-index", "--cached", "--quiet", origin.commit, "--").exitCode !== 0
        ) {
          if (gitText(path, "ls-files", "-z") || readdirSync(path).some((f) => f !== ".git"))
            throw Error("Partially occupied checkout");
          await execute("git", path, ["git", "read-tree", origin.commit]);
        }
        const missing = gitRead(path, "ls-files", "--deleted", "-z");
        if (missing.exitCode !== 0) throw Error("Cannot read index");
        if (missing.stdout.length)
          await execute(
            "git",
            path,
            ["git", "checkout-index", "-u", "-z", "--stdin"],
            missing.stdout,
          );
      }
      const modules = m.claim.settings.worktreeSubmodules;
      if (modules !== "none" && exists(join(path, ".gitmodules")))
        await execute("git", path, [
          "git",
          "submodule",
          "update",
          "--init",
          ...(modules === "recursive" ? ["--recursive"] : []),
        ]);
      if (reconcileWorktree(m.claim, observe(m)).action !== "recordVerified")
        throw Error("Incomplete checkout");
      change({ kind: "verified" });
    }
    const p = m.claim.phase;
    if (p.kind !== "preparing") return;
    const decision = reconcileWorktree(m.claim, observe(m)).action;
    if (decision === "inspect") throw Error("Checkout changed before setup");
    if (decision === "recordSetupUnknown" && p.script.kind === "started" && !retry) {
      change({ kind: "setupLost", attemptId: p.script.attemptId });
      return;
    }
    if (decision !== "resumeSetup" && !retry) return;
    if (!m.setup) {
      ready({ kind: "skipSetup" });
      return;
    }
    const attemptId =
      retry && p.script.kind === "started"
        ? p.script.attemptId
        : v.parse(AttemptIdSchema, crypto.randomUUID());
    if (!retry) change({ kind: "startSetup", attemptId });
    hook?.("beforeSetup", m);
    const code = await execute("setup", path, m.setup, Buffer.alloc(0), "setupExited");
    if (code === 0) ready({ kind: "setupPassed", attemptId });
    else
      change({
        kind: "setupFailed",
        attemptId,
        reason: `workspace_preparation_failed: setup exited ${code}`,
      });
  } catch {
    const p = m.claim.phase;
    if (p.kind === "preparing" && p.script.kind === "started")
      apply(m, { kind: "setupLost", attemptId: p.script.attemptId });
    m.inspection = true;
    persist();
  } finally {
    lease?.close();
  }
}
export function retryPreparation(
  ctx: CommandContext,
  p: Extract<SignedRequest, { method: "worktree.retrySetup" }>["payload"],
) {
  return record(
    ctx,
    REQUEST_METHODS.retryWorktreeSetup,
    p,
    { kind: "project", projectId: p.projectId },
    () => {
      const m = readManaged(ctx.transaction.db, p.worktreeId);
      if (!m || m.claim.threadId !== p.threadId || m.claim.projectId !== p.projectId)
        return reject(ctx.commandId, "notFound");
      if (
        m.claim.generation !== p.generation ||
        m.active ||
        m.inspection ||
        observe(m).disk !== "verifiedCheckout"
      )
        return reject(ctx.commandId, "invalidState");
      const result = transitionWorktree(m.claim, {
        ...p,
        kind: "retrySetup",
        operationId: m.claim.operationId,
        attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
      });
      if (result.kind !== "ok") return reject(ctx.commandId, "invalidState");
      m.claim = { ...result.value, settings: m.claim.settings };
      saveManaged(ctx.transaction.db, m);
      return { kind: "worktreeStatus", view: managedView(m) };
    },
  );
}
export async function restoreForInput(
  ctx: CommandContext,
  p: Extract<SignedRequest, { method: "input.send" }>["payload"],
  prepare: (m: Managed) => Promise<void>,
) {
  const { db } = ctx.transaction,
    target = { kind: "thread" as const, threadId: p.threadId },
    method = REQUEST_METHODS.sendInput;
  const begin = db.transaction(() => {
    const checked = checkCommand(ctx, method, p, target);
    if (checked.receipt) return checked.receipt;
    const thread = readThread(db, p.threadId),
      m = thread?.worktreeId && readManaged(db, thread.worktreeId);
    if (!thread || !m) return null;
    if (m.claim.phase.kind === "absent") {
      const seen = observe(m);
      if (
        seen.disk !== "absent" ||
        seen.registration !== "absent" ||
        seen.child.kind !== "none" ||
        m.inspection
      )
        return null;
      const origin = rebuildSource(m);
      if (!origin) return null;
      const nextGeneration = v.parse(
        WorktreeGenerationSchema,
        String(BigInt(m.claim.generation) + 1n),
      );
      apply(m, { kind: "rebuild", nextGeneration, origin }, ctx.commandId);
      m.disk = null;
      m.admin = null;
      m.branchOwned = false;
      m.directory.binding.generation = nextGeneration;
      thread.directory = m.directory.binding;
      db.run("UPDATE threads SET data=? WHERE id=?", [JSON.stringify(thread), thread.id]);
      saveManaged(db, m);
    }
    const phase = m.claim.phase;
    if (
      "origin" in phase &&
      phase.origin.prior.kind === "rebuild" &&
      (phase.kind === "building" || phase.kind === "preparing")
    ) {
      db.run("INSERT OR IGNORE INTO restoring_commands VALUES(?,?,?)", [
        ctx.actor.id,
        ctx.commandId,
        checked.intent,
      ]);
      return m;
    }
    return null;
  })();
  if (begin && "commandId" in begin) return begin;
  if (begin) await prepare(begin);
  return record(ctx, method, p, target, () => {
    const thread = readThread(db, p.threadId),
      m = thread?.worktreeId && readManaged(db, thread.worktreeId);
    if (!thread) return reject(ctx.commandId, "notFound");
    if (!m) return reject(ctx.commandId, "unsupported");
    db.run("DELETE FROM restoring_commands WHERE actor=? AND command=?", [
      ctx.actor.id,
      ctx.commandId,
    ]);
    const phase = m.claim.phase,
      view = managedView(m);
    if (view.availability === "usable") {
      if (phase.kind === "ready" && phase.origin.prior.kind === "rebuild")
        return { kind: "worktreeStatus", view };
      return reject(ctx.commandId, "unsupported");
    }
    const reason =
      phase.kind === "preparing" && phase.script.kind === "failed"
        ? "setupFailed"
        : phase.kind === "absent" &&
            (!exists(m.root.realPath) || view.availability !== "needsInspection")
          ? "sourceUnavailable"
          : "ownershipUnconfirmed";
    return {
      kind: "rejected",
      commandId: ctx.commandId,
      failure: {
        kind: "worktreeRestoreFailed",
        threadId: thread.id,
        worktreeId: m.claim.worktreeId,
        generation: m.claim.generation,
        reason,
        view,
      },
    } satisfies CommandReceipt;
  });
}
