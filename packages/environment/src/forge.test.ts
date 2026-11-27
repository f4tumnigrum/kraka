import { planPullVerification } from "./forge-recovery";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ForgePublishSchema,
  CommandIdSchema,
  AttemptIdSchema,
  PrincipalIdSchema,
  GitObjectIdSchema,
  ForgeProgressSchema,
  ForgeMarkRequestSchema,
  ForgeWatchSchema,
  REQUEST_METHODS,
  type ForgeProof,
  type ForgeHistory,
} from "@kraka/protocol";
import {
  registerPublication,
  advancePublication,
  recoverPublication,
  PublicationBookSchema,
  updateForgeMark,
  readStoredForgeMark,
  compareForgeFile,
  type FrozenPublication,
  type PublicationBook,
  type PublicationEvent,
  type PullLookup,
  type PullMatch,
} from "./forge";
import { applyForgeHistory, startForgeWatch, finishHistoryRead } from "./forge-history";

const repository = { platform: "github", host: "github.com", id: "repo" } as const;
const source = { repository, name: "work" },
  target = { repository, name: "main" };
const request = v.parse(ForgePublishSchema, {
  threadId: "thread",
  projectId: "project",
  worktreeId: "checkout",
  source,
  target,
  createBranch: true,
  commit: { paths: ["a.ts"], message: "Fix a" },
  push: true,
  pullRequest: { title: "Fix a", body: "One change" },
});
const commandId = v.parse(CommandIdSchema, "publish"),
  attemptId = v.parse(AttemptIdSchema, "attempt"),
  ticket = { commandId, attemptId };
const scope = { ...request, repository, owner: v.parse(PrincipalIdSchema, "owner") };
const oid = (c: string) => v.parse(GitObjectIdSchema, c.repeat(40));
const identity = { name: "Author", email: "fixture-author", timestamp: "1 +0000" };
const intent: FrozenPublication = {
  parent: oid("a"),
  parentTree: oid("b"),
  selectedTree: oid("c"),
  tip: oid("d"),
  author: identity,
  committer: identity,
  expectedRemoteTip: null,
};
const pulls: PullLookup = {
  source,
  target,
  tip: intent.tip,
  scope: "open",
  complete: true,
  matches: [],
};
const issues: PublicationEvent[] = [
  {
    ...ticket,
    kind: "issue",
    seen: {
      step: "branch",
      branch: source,
      worktreeId: request.worktreeId,
      checkoutParent: intent.parent,
      expectedBranchAbsent: true,
    },
  },
  {
    ...ticket,
    kind: "issue",
    seen: {
      step: "commit",
      worktreeId: request.worktreeId,
      branch: source,
      refOid: intent.parent,
      symbolicHead: "refs/heads/work",
      head: intent.parent,
      selectedTree: intent.selectedTree,
    },
  },
  {
    ...ticket,
    kind: "issue",
    seen: {
      step: "push",
      branch: source,
      remoteTip: null,
      localTip: intent.tip,
      fastForward: true,
    },
  },
  { ...ticket, kind: "preparePull", lookup: pulls },
];
const proofs: ForgeProof[] = [
  {
    step: "branch",
    checkedOutRef: "refs/heads/work",
    branch: source,
    parent: intent.parent,
    worktreeId: request.worktreeId,
  },
  {
    step: "commit",
    worktreeId: request.worktreeId,
    branch: source,
    parent: intent.parent,
    tree: intent.selectedTree,
    inBranchHistory: true,
    oid: intent.tip,
    paths: ["a.ts"],
    priorEdits: { kind: "unknown" },
  },
  { step: "push", branch: source, tip: intent.tip, origin: "pushed" },
  {
    step: "pullRequest",
    source,
    target,
    publicationHead: intent.tip,
    currentHead: intent.tip,
    verifiedMember: null,
    evidence: "createReply",
    marker: commandId,
    number: 19,
    state: "open",
    origin: "created",
  },
];
function initial() {
  const r = registerPublication(null, scope, commandId, request, intent);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.book;
}
function move(book: PublicationBook, event: PublicationEvent) {
  const r = advancePublication(book, event);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.book;
}
function restart(book: PublicationBook) {
  return recoverPublication(v.parse(PublicationBookSchema, JSON.parse(JSON.stringify(book))));
}
function through(steps: number) {
  let book = initial();
  for (const [i, proof] of proofs.slice(0, steps).entries()) {
    const issue = issues[i];
    if (!issue) throw new Error("Missing issue");
    book = move(move(book, issue), { ...ticket, kind: "proof", proof });
  }
  return book;
}

test("a crash after issuing each step reconciles the original proof and preserves every earlier receipt", () => {
  for (const [i, proof] of proofs.entries()) {
    const prior = through(i),
      issue = issues[i];
    if (!issue) throw new Error("Missing issue");
    const issued = move(prior, issue);
    expect(advancePublication(issued, issue).kind).toBe("rejected");
    const recovered = restart(issued);
    expect(recovered.progress.steps[proof.step]).toMatchObject({ kind: "verify", attemptId });
    const duplicate = registerPublication(recovered, scope, commandId, request, {
      ...intent,
      tip: oid("f"),
    });
    expect(duplicate).toEqual({ kind: "ok", book: recovered });
    expect(advancePublication(recovered, issue).kind).toBe("rejected");
    const settled =
      proof.step === "pullRequest"
        ? move(recovered, {
            ...ticket,
            kind: "reconcilePull",
            lookup: {
              ...pulls,
              scope: "all",
              matches: [
                {
                  source,
                  target,
                  currentHead: null,
                  verifiedMember: null,
                  number: 19,
                  state: "closed",
                  marker: commandId,
                },
              ],
            },
          })
        : move(recovered, {
            ...ticket,
            kind: "reconcile",
            proof: proof.step === "push" ? { ...proof, origin: "observed" } : proof,
          });
    expect(settled.progress.steps[proof.step]).toMatchObject({
      kind: "done",
      proof:
        proof.step === "pullRequest"
          ? { number: 19, state: "closed", origin: "created" }
          : proof.step === "push"
            ? { ...proof, origin: "observed" }
            : proof,
    });
    for (const earlier of proofs.slice(0, i))
      expect(settled.progress.steps[earlier.step]).toEqual(prior.progress.steps[earlier.step]);
    expect(restart(settled)).toEqual(settled);
  }
  expect(v.parse(ForgeProgressSchema, through(4).progress).steps.pullRequest.kind).toBe("done");
});

test("an empty, incomplete or ambiguous search after a lost PR response cannot create a second PR", () => {
  const before = through(3);
  const issued = move(before, { ...ticket, kind: "preparePull", lookup: pulls });
  const pending = move(issued, {
    ...ticket,
    kind: "lost",
    step: "pullRequest",
    reason: "connection lost",
  });
  const match = {
    source,
    target,
    currentHead: intent.tip,
    verifiedMember: null,
    number: 27,
    state: "open" as const,
    marker: null,
  };
  for (const listing of [
    { ...pulls, scope: "all" as const },
    { ...pulls, scope: "all" as const, complete: false, matches: [match] },
    { ...pulls, scope: "all" as const, matches: [match, { ...match, number: 29 }] },
    { ...pulls, matches: [match] },
  ]) {
    const unchanged = move(pending, { ...ticket, kind: "reconcilePull", lookup: listing });
    expect(unchanged).toBe(pending);
    expect(
      advancePublication(unchanged, { ...ticket, kind: "preparePull", lookup: pulls }).kind,
    ).toBe("rejected");
  }
  const found = move(pending, {
    ...ticket,
    kind: "reconcilePull",
    lookup: { ...pulls, scope: "all", matches: [match] },
  });
  expect(found.progress.steps.pullRequest).toMatchObject({
    kind: "done",
    proof: { number: 27, origin: "observed" },
  });
  expect(
    move(before, { ...ticket, kind: "preparePull", lookup: { ...pulls, matches: [match] } })
      .progress.steps.pullRequest,
  ).toMatchObject({ kind: "done", proof: { number: 27, origin: "existing" } });
  expect(
    move(before, { ...ticket, kind: "preparePull", lookup: { ...pulls, tip: oid("e") } }),
  ).toMatchObject({
    progress: { steps: { pullRequest: { kind: "waiting", blocked: { reason: "headChanged" } } } },
  });
});

test("rejects foreign repositories, reused commands with different input, stale attempts and mismatched Git evidence", () => {
  const book = initial();
  for (const repo of [
    { ...repository, id: "other" },
    { ...repository, host: "other.example" },
  ]) {
    for (const pair of [
      { source: { ...source, repository: repo }, target },
      { source, target: { ...target, repository: repo } },
    ]) {
      expect(registerPublication(null, scope, commandId, { ...request, ...pair }, intent)).toEqual({
        kind: "rejected",
        reason: "crossRepository",
      });
    }
  }
  expect(registerPublication(book, scope, commandId, { ...request, push: false }, intent)).toEqual({
    kind: "rejected",
    reason: "idConflict",
  });
  const issued = move(book, {
    ...ticket,
    kind: "issue",
    seen: {
      step: "branch",
      branch: source,
      worktreeId: request.worktreeId,
      checkoutParent: intent.parent,
      expectedBranchAbsent: true,
    },
  });
  const recovered = restart(issued),
    next = v.parse(AttemptIdSchema, "new attempt");
  const reissued = move(recovered, {
    ...ticket,
    kind: "retryGitAfterFence",
    nextAttemptId: next,
    seen: {
      step: "branch",
      branch: source,
      worktreeId: request.worktreeId,
      checkoutParent: intent.parent,
      expectedBranchAbsent: true,
    },
  });
  const proof = proofs[0];
  if (proof?.step !== "branch") throw new Error("Expected branch proof");
  expect(advancePublication(reissued, { ...ticket, kind: "proof", proof })).toMatchObject({
    kind: "rejected",
    reason: "wrongAttempt",
  });
  expect(
    advancePublication(reissued, {
      commandId,
      attemptId: next,
      kind: "proof",
      proof: { ...proof, parent: oid("f") },
    }),
  ).toMatchObject({ kind: "rejected", reason: "wrongProof" });
  expect(
    advancePublication(through(2), {
      ...ticket,
      kind: "issue",
      seen: {
        step: "push",
        branch: source,
        localTip: intent.tip,
        remoteTip: oid("e"),
        fastForward: false,
      },
    }).kind,
  ).toBe("rejected");
  const unchanged = registerPublication(
    null,
    scope,
    commandId,
    { ...request, createBranch: false },
    { ...intent, selectedTree: intent.parentTree, tip: intent.parent },
  );
  expect(unchanged).toMatchObject({
    kind: "ok",
    book: {
      progress: {
        steps: {
          branch: { kind: "skipped", reason: "omitted" },
          commit: { kind: "skipped", reason: "noChanges" },
        },
      },
    },
  });
});

test("keeps compared, baseline-free and unanswered file reads distinct for each owner and account", () => {
  const file = {
    accountId: "account",
    pull: { repository, number: 19 },
    headOid: intent.tip,
    path: "a.ts",
  };
  const value = { kind: "blob" as const, mode: "100644", oid: intent.tip };
  const edit = v.parse(ForgeMarkRequestSchema, {
    file,
    threadId: request.threadId,
    baseVersion: "0",
    mark: { kind: "marked", value },
  });
  const saved = updateForgeMark(null, scope, file.accountId, commandId, edit, null);
  if (saved.kind !== "saved") throw new Error("Expected saved mark");
  const legacyFile = { accountId: file.accountId, pull: file.pull, path: file.path };
  expect(readStoredForgeMark({ ...saved.row, file: legacyFile })).toMatchObject({
    kind: "noBaseline",
  });
  expect(v.safeParse(ForgeMarkRequestSchema, { ...edit, file: legacyFile }).success).toBe(false);
  const nextHeadEdit = v.parse(ForgeMarkRequestSchema, {
    ...edit,
    file: { ...file, headOid: "b".repeat(40) },
    baseVersion: saved.row.version,
  });
  expect(
    updateForgeMark(
      saved.row,
      scope,
      file.accountId,
      v.parse(CommandIdSchema, "next-head"),
      nextHeadEdit,
      null,
    ),
  ).toMatchObject({
    kind: "rejected",
    reason: "wrongScope",
  });
  const cleared = updateForgeMark(
    saved.row,
    scope,
    file.accountId,
    v.parse(CommandIdSchema, "clear"),
    { ...edit, baseVersion: saved.row.version, mark: { kind: "unmarked" } },
    null,
  );
  if (cleared.kind !== "saved") throw new Error("Expected a new mark revision");
  expect(
    updateForgeMark(cleared.row, scope, file.accountId, commandId, edit, saved.receipt),
  ).toEqual({ kind: "replay", receipt: saved.receipt });
  expect(compareForgeFile(saved.row.mark, value).kind).toBe("equal");
  expect(compareForgeFile(saved.row.mark, { ...value, mode: "100755" }).kind).toBe("changed");
  expect(compareForgeFile(saved.row.mark, { kind: "deleted" }).kind).toBe("changed");
  expect(compareForgeFile(saved.row.mark, { kind: "noAnswer" })).toEqual({ kind: "noAnswer" });
  expect(compareForgeFile({ kind: "noBaseline" }, value)).toEqual({ kind: "noBaseline" });
  expect(compareForgeFile({ kind: "unmarked" }, value)).toEqual({ kind: "unmarked" });
  expect(updateForgeMark(saved.row, scope, "other", commandId, edit, null)).toMatchObject({
    kind: "rejected",
    reason: "wrongScope",
  });
  expect(
    updateForgeMark(
      saved.row,
      scope,
      file.accountId,
      v.parse(CommandIdSchema, "new mark"),
      edit,
      null,
    ),
  ).toMatchObject({
    kind: "rejected",
    reason: "versionConflict",
  });
  expect(REQUEST_METHODS.publishForge.permission).toBe("workspace.change");
});

test("backfills transient failures from complete history and reports a gap for current-only or truncated sources", () => {
  const watch = v.parse(ForgeWatchSchema, {
    threadId: request.threadId,
    pull: { repository, number: 19 },
    generation: "watch",
  });
  const opened = startForgeWatch(scope, watch, 10);
  if (opened.kind !== "ok") throw new Error(opened.reason);
  const old = opened.observation;
  expect(
    startForgeWatch(
      scope,
      { ...watch, pull: { ...watch.pull, repository: { ...repository, id: "foreign" } } },
      10,
    ),
  ).toMatchObject({ kind: "rejected", reason: "crossRepository" });
  const check = {
    kind: "check" as const,
    id: "build",
    version: "first",
    at: 11,
    head: intent.tip,
    result: "failed" as const,
  };
  const batch: Omit<ForgeHistory, "coverage"> = {
    watch,
    source: "checks",
    from: 10,
    through: 20,
    events: [check, { ...check, at: 12, version: "second", result: "passed" }],
  };
  const complete = finishHistoryRead(batch, {
    kind: "history",
    retainedFrom: 0,
    retainedThrough: 20,
    nextPage: null,
  });
  const recovery = applyForgeHistory(old, complete);
  if (recovery.kind !== "ok") throw new Error(recovery.reason);
  expect(recovery.notices.map((n) => (n.kind === "event" ? n.event.version : n.kind))).toEqual([
    "first",
    "second",
  ]);
  expect(recovery.observation.streams.checks.through).toBe(20);
  expect(applyForgeHistory(recovery.observation, complete)).toMatchObject({
    kind: "ok",
    notices: [],
  });
  for (const evidence of [
    { kind: "currentOnly" },
    { kind: "history", retainedFrom: 15, retainedThrough: 20, nextPage: null },
    { kind: "history", retainedFrom: 0, retainedThrough: 20, nextPage: "next" },
  ] as const) {
    const gap = finishHistoryRead({ ...batch, events: batch.events.slice(1) }, evidence);
    const partial = applyForgeHistory(old, gap);
    if (partial.kind !== "ok") throw new Error(partial.reason);
    expect(partial.notices.map((n) => n.kind)).toEqual(["event", "gap"]);
    expect(partial.observation.streams.checks.through).toBe(10);
    expect(applyForgeHistory(partial.observation, gap)).toMatchObject({ kind: "ok", notices: [] });
    const repaired = applyForgeHistory(partial.observation, complete);
    expect(repaired).toMatchObject({
      kind: "ok",
      notices: [{ kind: "event", event: { result: "failed" } }],
      observation: { gaps: {}, streams: { checks: { through: 20 }, discussion: { through: 10 } } },
    });
  }
  expect(
    applyForgeHistory(old, { ...complete, watch: { ...watch, generation: commandId } }),
  ).toEqual({ kind: "rejected", reason: "wrongWatch" });
});

test("only a newly issued row authorizes a write, and a half-created branch resumes just the checkout", () => {
  const empty = initial(),
    issue = issues[0];
  if (!issue) throw new Error("Expected branch issue");
  const branch = advancePublication(empty, issue);
  if (branch.kind !== "ok") throw new Error(branch.reason);
  expect(branch.dispatch?.action).toBe("createBranchAndCheckout");
  const resumed = advancePublication(restart(branch.book), {
    ...ticket,
    kind: "finishCheckoutAfterFence",
    worktreeId: request.worktreeId,
    nextAttemptId: v.parse(AttemptIdSchema, "checkout only"),
    branch: source,
    startedAt: intent.parent,
    checkoutParent: intent.parent,
  });
  expect(resumed).toMatchObject({ kind: "ok", dispatch: { action: "checkoutExistingBranch" } });
  const full = through(4);
  expect(registerPublication(full, scope, commandId, request, intent)).toEqual({
    kind: "ok",
    book: full,
  });
  const before = through(3);
  const send = advancePublication(before, { ...ticket, kind: "preparePull", lookup: pulls });
  if (send.kind !== "ok") throw new Error(send.reason);
  expect(send.dispatch?.action).toBe("createPullRequest");
  const check = restart(send.book);
  const confirmed = advancePublication(check, {
    ...ticket,
    kind: "reconcilePull",
    knownCreation: { ...ticket, source, target, publicationHead: intent.tip, number: 55 },
    lookup: {
      ...pulls,
      scope: "all",
      tip: null,
      matches: [
        {
          source,
          target,
          currentHead: null,
          verifiedMember: null,
          state: "merged",
          number: 55,
          marker: null,
        },
      ],
    },
  });
  expect(confirmed).toMatchObject({
    kind: "ok",
    book: {
      progress: {
        steps: { pullRequest: { kind: "done", proof: { number: 55, origin: "observed" } } },
      },
    },
  });
  expect(confirmed).not.toHaveProperty("dispatch");
});

test("a different worktree or checked out branch at the same commit cannot acquire write permission", () => {
  const waiting = through(1);
  const observed = {
    step: "commit" as const,
    branch: source,
    worktreeId: request.worktreeId,
    refOid: intent.parent,
    symbolicHead: "refs/heads/work",
    head: intent.parent,
    selectedTree: intent.selectedTree,
  };
  for (const seen of [
    { ...observed, symbolicHead: null },
    { ...observed, symbolicHead: "refs/heads/other" },
    { ...observed, refOid: null },
    { ...observed, branch: target },
    { ...observed, refOid: oid("f") },
  ]) {
    expect(advancePublication(waiting, { ...ticket, kind: "issue", seen })).toMatchObject({
      kind: "rejected",
    });
  }
  const issued = move(waiting, { ...ticket, kind: "issue", seen: observed });
  const proof = proofs[1];
  if (proof?.step !== "commit") throw Error("Expected commit");
  for (const invalid of [
    { ...proof, branch: target },
    { ...proof, parent: oid("f") },
    { ...proof, tree: oid("f") },
    { ...proof, paths: ["extra"] },
    { ...proof, paths: [] },
  ]) {
    expect(advancePublication(issued, { ...ticket, kind: "proof", proof: invalid })).toMatchObject({
      kind: "rejected",
      reason: "wrongProof",
    });
  }
});
test("first PR lookup deduplicates pages and reports ambiguity before granting a write", () => {
  const initial = through(3);
  const row = {
    source,
    target,
    number: 7,
    state: "open" as const,
    marker: null,
    currentHead: intent.tip,
    verifiedMember: null,
  };
  const prepare = (matches: PullLookup["matches"]) =>
    move(initial, { ...ticket, kind: "preparePull", lookup: { ...pulls, matches } }).progress.steps
      .pullRequest;
  expect(prepare([row, { ...row, number: 3, marker: commandId }, row])).toEqual({
    kind: "waiting",
    blocked: { reason: "ambiguous", numbers: [3, 7] },
  });
  expect(prepare([row, row])).toMatchObject({
    kind: "done",
    proof: { number: 7, origin: "existing", publicationHead: intent.tip },
  });
  expect(prepare([{ ...row, currentHead: oid("e") }])).toMatchObject({
    kind: "waiting",
    blocked: { reason: "headChanged" },
  });
});
test("a moved pull head requires evidence tied to the original publication", () => {
  const pending = restart(move(through(3), { ...ticket, kind: "preparePull", lookup: pulls }));
  const row = {
    source,
    target,
    number: 11,
    state: "open" as const,
    marker: null,
    currentHead: oid("e"),
    verifiedMember: null,
  };
  const read = (match: PullMatch) =>
    move(pending, {
      ...ticket,
      kind: "reconcilePull",
      lookup: { ...pulls, scope: "all", matches: [match] },
    });
  expect(read(row)).toBe(pending);
  expect(read({ ...row, marker: v.parse(CommandIdSchema, "foreign") })).toBe(pending);
  expect(read({ ...row, verifiedMember: intent.tip })).toMatchObject({
    progress: {
      steps: {
        pullRequest: {
          kind: "done",
          proof: {
            origin: "observed",
            evidence: "member",
            currentHead: row.currentHead,
            publicationHead: intent.tip,
          },
        },
      },
    },
  });
  expect(read({ ...row, state: "merged", marker: commandId })).toMatchObject({
    progress: {
      steps: { pullRequest: { kind: "done", proof: { origin: "created", evidence: "marker" } } },
    },
  });
});
test("recovery reserves one due read across restart and honors the matching account limit", () => {
  const progress = restart(
    move(through(3), { ...ticket, kind: "preparePull", lookup: pulls }),
  ).progress;
  const schedule = {
    ...ticket,
    host: repository.host,
    accountId: "account",
    nextCheckAt: 10,
    paused: null,
  };
  const limit = { host: repository.host, accountId: "account", until: 100 };
  expect(planPullVerification(progress, schedule, limit, 20)).toEqual({ kind: "wait", until: 100 });
  const read = planPullVerification(progress, schedule, { ...limit, accountId: "other" }, 20);
  if (read.kind !== "read") throw Error("Expected one read");
  expect(planPullVerification(progress, read.reservation, null, 21)).toEqual({
    kind: "wait",
    until: 120020,
  });
  expect(planPullVerification(progress, { ...schedule, paused: "offline" }, null, 120021)).toEqual({
    kind: "paused",
  });
  expect(planPullVerification(through(4).progress, schedule, null, 120021)).toEqual({
    kind: "retired",
  });
});
