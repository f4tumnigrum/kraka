import * as v from "valibot";
import {
  ForgeProgressSchema,
  ForgeFileKeySchema,
  ForgeReadMarkSchema,
  PrincipalIdSchema,
  GitObjectIdSchema,
  ObjectVersionSchema,
  type ObjectVersion,
  type ForgeMarkRequest,
} from "@kraka/protocol";
import type {
  AttemptId,
  CommandId,
  ForgeAccount,
  ForgeBranch,
  ForgeFileKey,
  ForgeFileValue,
  ForgeHistory,
  ForgeHistorySource,
  ForgeProgress,
  ForgeProof,
  ForgePublish,
  ForgeReadMark,
  ForgeReadResult,
  ForgeRemote,
  ForgeRepository,
  ForgeUnavailableReason,
  ForgeWatch,
  GitObjectId,
  PrincipalId,
} from "@kraka/protocol";

/** Resolve only the logged-in gh account for this environment's configured GitHub host. */
export interface GitHubTokenSource {
  githubToken(host: string): Promise<string | null>;
}

export type PullMatch = import("@kraka/protocol").ForgePullMatch;
export type PullLookup = {
  source: ForgeBranch;
  target: ForgeBranch;
  tip: GitObjectId | null;
  scope: "open" | "all";
  complete: boolean;
  matches: readonly PullMatch[];
};
export type ForgeUnavailable = { kind: "unavailable"; reason: ForgeUnavailableReason };
/** Each lookup borrows the host's login for that one operation and verifies the account again. */
export interface ForgeLookupDriver {
  readonly platform: ForgeRepository["platform"];
  account(host: string): Promise<{ kind: "verified"; account: ForgeAccount } | ForgeUnavailable>;
  /** A name only locates the repository. Callers keep and compare the permanent ID. */
  repository(
    remote: ForgeRemote,
  ): Promise<
    { kind: "resolved"; account: ForgeAccount; repository: ForgeRepository } | ForgeUnavailable
  >;
}
/** Network implementations use the GitHub API. Git branch, commit and push work stays with the workspace. */
export interface ForgeDriver extends ForgeLookupDriver {
  findPulls(
    request: Pick<ForgePublish, "source" | "target">,
    includeClosed: boolean,
  ): Promise<PullLookup>;
  createPull(
    effect: Extract<PublicationDispatch, { action: "createPullRequest" }>,
  ): Promise<PullMatch>;
  readHistory(
    watch: ForgeWatch,
    source: ForgeHistorySource,
    from: number,
    through: number,
  ): Promise<ForgeHistory>;
  readFile(file: ForgeFileKey): Promise<ForgeFileValue | { kind: "noAnswer" }>;
}
export type GitHubDriverFactory = (credentials: GitHubTokenSource) => ForgeDriver;

export function sameForgeRepository(a: ForgeRepository, b: ForgeRepository): boolean {
  return a.platform === b.platform && a.host === b.host && a.id === b.id;
}
function sameBranch(a: ForgeBranch, b: ForgeBranch) {
  return a.name === b.name && sameForgeRepository(a.repository, b.repository);
}
export function compareForgeFile(
  mark: ForgeReadMark,
  now: ForgeFileValue | { kind: "noAnswer" },
): ForgeReadResult {
  if (mark.kind !== "marked") return { kind: mark.kind };
  if (now.kind === "noAnswer") return { kind: "noAnswer" };
  const before = mark.value;
  const equal =
    before.kind === "deleted"
      ? now.kind === "deleted"
      : now.kind === "blob" && now.oid === before.oid && now.mode === before.mode;
  return { kind: equal ? "equal" : "changed", before, now };
}

const identity = v.strictObject({ name: v.string(), email: v.string(), timestamp: v.string() });
/** The workspace pins the exact commit inputs before granting the first external write. */
export const FrozenPublicationSchema = v.strictObject({
  parent: GitObjectIdSchema,
  parentTree: GitObjectIdSchema,
  selectedTree: GitObjectIdSchema,
  tip: GitObjectIdSchema,
  author: identity,
  committer: identity,
  expectedRemoteTip: v.nullable(GitObjectIdSchema),
});
export type FrozenPublication = v.InferOutput<typeof FrozenPublicationSchema>;
export type ForgeScope = Pick<ForgePublish, "projectId" | "threadId" | "worktreeId"> & {
  owner: PrincipalId;
  repository: ForgeRepository;
};
export const PublicationBookSchema = v.strictObject({
  owner: PrincipalIdSchema,
  intent: FrozenPublicationSchema,
  progress: ForgeProgressSchema,
});
export type PublicationBook = v.InferOutput<typeof PublicationBookSchema>;
type Step = keyof ForgeProgress["steps"];
const order = ["branch", "commit", "push", "pullRequest"] as const;
export type PublicationDispatch = { commandId: CommandId; attemptId: AttemptId } & (
  | {
      action: "createBranchAndCheckout" | "checkoutExistingBranch";
      branch: ForgeBranch;
      parent: GitObjectId;
      worktreeId: ForgePublish["worktreeId"];
    }
  | {
      action: "commit";
      branch: ForgeBranch;
      worktreeId: ForgePublish["worktreeId"];
      input: NonNullable<ForgePublish["commit"]>;
      parent: GitObjectId;
      tree: GitObjectId;
      expectedCommit: GitObjectId;
      author: FrozenPublication["author"];
      committer: FrozenPublication["committer"];
    }
  | {
      action: "push";
      branch: ForgeBranch;
      expectedOld: GitObjectId | null;
      newTip: GitObjectId;
      fastForwardOnly: true;
    }
  | {
      action: "createPullRequest";
      source: ForgeBranch;
      target: ForgeBranch;
      tip: GitObjectId;
      title: string;
      body: string;
      marker: CommandId;
    }
);
type Result =
  | { kind: "ok"; book: PublicationBook; dispatch?: PublicationDispatch }
  | {
      kind: "rejected";
      reason:
        | "crossRepository"
        | "idConflict"
        | "invalidIntent"
        | "wrongAttempt"
        | "invalidState"
        | "wrongProof";
    };
const ok = (book: PublicationBook): Result => ({ kind: "ok", book });
function reject(reason: Extract<Result, { kind: "rejected" }>["reason"]): Result {
  return { kind: "rejected", reason };
}

function sameRequest(a: ForgePublish, b: ForgePublish) {
  return (
    a.threadId === b.threadId &&
    a.projectId === b.projectId &&
    a.worktreeId === b.worktreeId &&
    sameBranch(a.source, b.source) &&
    sameBranch(a.target, b.target) &&
    a.createBranch === b.createBranch &&
    a.push === b.push &&
    a.pullRequest?.title === b.pullRequest?.title &&
    a.pullRequest?.body === b.pullRequest?.body &&
    a.commit?.message === b.commit?.message &&
    (a.commit === null
      ? b.commit === null
      : b.commit !== null &&
        a.commit.paths.length === b.commit.paths.length &&
        a.commit.paths.every((path, i) => path === b.commit?.paths[i]))
  );
}
/** Called under the authorized project/worktree binding. Lookup the command before refreshing any frozen inputs. */
export function registerPublication(
  existing: PublicationBook | null,
  scope: ForgeScope,
  commandId: CommandId,
  request: ForgePublish,
  intent: FrozenPublication,
): Result {
  const { owner, repository } = scope;
  if (
    request.projectId !== scope.projectId ||
    request.threadId !== scope.threadId ||
    request.worktreeId !== scope.worktreeId
  )
    return reject("invalidIntent");
  if (
    !sameForgeRepository(repository, request.source.repository) ||
    !sameForgeRepository(repository, request.target.repository)
  )
    return reject("crossRepository");
  if (existing)
    return existing.owner === owner &&
      existing.progress.commandId === commandId &&
      sameRequest(existing.progress.request, request)
      ? ok(existing)
      : reject("idConflict");
  const skip = { kind: "skipped", reason: "omitted" } as const,
    wait = { kind: "waiting" } as const;
  const noChanges = intent.parentTree === intent.selectedTree;
  if (
    (!request.createBranch && !request.commit && !request.push && !request.pullRequest) ||
    (request.pullRequest && sameBranch(request.source, request.target))
  )
    return reject("invalidIntent");
  if (
    ((!request.commit || noChanges) && intent.tip !== intent.parent) ||
    (request.commit && !noChanges && intent.tip === intent.parent)
  )
    return reject("invalidIntent");
  return ok(
    v.parse(PublicationBookSchema, {
      owner,
      intent,
      progress: {
        commandId,
        request,
        steps: {
          branch: request.createBranch ? wait : skip,
          commit: !request.commit
            ? skip
            : noChanges
              ? { kind: "skipped", reason: "noChanges" }
              : wait,
          push: request.push ? wait : skip,
          pullRequest: request.pullRequest ? wait : skip,
        },
      },
    }),
  );
}

/** These readings are taken under the original workspace lease, against the pinned branch and repository. */
export type GitPreflight =
  | {
      step: "branch";
      branch: ForgeBranch;
      worktreeId: ForgePublish["worktreeId"];
      expectedBranchAbsent: boolean;
      checkoutParent: GitObjectId;
    }
  | {
      step: "commit";
      worktreeId: ForgePublish["worktreeId"];
      branch: ForgeBranch;
      refOid: GitObjectId | null;
      symbolicHead: string | null;
      head: GitObjectId | null;
      selectedTree: GitObjectId;
    }
  | {
      step: "push";
      branch: ForgeBranch;
      remoteTip: GitObjectId | null;
      localTip: GitObjectId;
      fastForward: boolean;
    };
function gitPreconditions(book: PublicationBook, seen: GitPreflight) {
  const {
    intent,
    progress: { request },
  } = book;
  switch (seen.step) {
    case "branch":
      return (
        seen.worktreeId === request.worktreeId &&
        sameBranch(seen.branch, request.source) &&
        seen.expectedBranchAbsent &&
        seen.checkoutParent === intent.parent
      );
    case "commit":
      return (
        seen.worktreeId === request.worktreeId &&
        sameBranch(seen.branch, request.source) &&
        seen.refOid === intent.parent &&
        seen.symbolicHead === `refs/heads/${request.source.name}` &&
        seen.head === intent.parent &&
        seen.selectedTree === intent.selectedTree
      );
    case "push":
      return (
        sameBranch(seen.branch, request.source) &&
        seen.localTip === intent.tip &&
        seen.remoteTip === intent.expectedRemoteTip &&
        (seen.remoteTip === null || seen.fastForward)
      );
  }
}
type EventBase = { commandId: CommandId; attemptId: AttemptId };
export type PublicationEvent = EventBase &
  (
    | {
        kind: "finishCheckoutAfterFence";
        worktreeId: ForgePublish["worktreeId"];
        nextAttemptId: AttemptId;
        branch: ForgeBranch;
        startedAt: GitObjectId;
        checkoutParent: GitObjectId;
      }
    | { kind: "issue"; seen: GitPreflight }
    | { kind: "retryGitAfterFence"; seen: GitPreflight; nextAttemptId: AttemptId }
    | { kind: "preparePull"; lookup: PullLookup }
    | { kind: "proof"; proof: ForgeProof }
    | { kind: "lost" | "refused"; step: Step; reason: string }
    | { kind: "reconcile"; proof: Exclude<ForgeProof, { step: "pullRequest" }> }
    | {
        kind: "reconcilePull";
        lookup: PullLookup;
        knownCreation?: EventBase &
          Pick<
            Extract<ForgeProof, { step: "pullRequest" }>,
            "number" | "source" | "target" | "publicationHead"
          >;
      }
  );
function writeStep<K extends Step>(
  book: PublicationBook,
  step: K,
  state: ForgeProgress["steps"][K],
): Result {
  return ok({
    ...book,
    progress: { ...book.progress, steps: { ...book.progress.steps, [step]: state } },
  });
}
/** Only use the dispatch after a successful conditional commit of this exact step transition. */
function issueStep(
  book: PublicationBook,
  step: Step,
  attemptId: AttemptId,
  finishCheckout = false,
): Result {
  const progress = {
    ...book.progress,
    steps: { ...book.progress.steps, [step]: { kind: "issued", attemptId } },
  };
  const { request, commandId } = progress;
  const next = { ...book, progress };
  const ticket = { commandId, attemptId };
  const { intent } = book;
  switch (step) {
    case "branch":
      return {
        kind: "ok",
        book: next,
        dispatch: {
          ...ticket,
          action: finishCheckout ? "checkoutExistingBranch" : "createBranchAndCheckout",
          branch: request.source,
          parent: intent.parent,
          worktreeId: request.worktreeId,
        },
      };
    case "commit":
      if (!request.commit) throw new Error("A skipped commit cannot acquire dispatch rights");
      return {
        kind: "ok",
        book: next,
        dispatch: {
          ...ticket,
          action: "commit",
          worktreeId: request.worktreeId,
          branch: request.source,
          input: request.commit,
          parent: intent.parent,
          tree: intent.selectedTree,
          expectedCommit: intent.tip,
          author: intent.author,
          committer: intent.committer,
        },
      };
    case "push":
      return {
        kind: "ok",
        book: next,
        dispatch: {
          ...ticket,
          action: "push",
          branch: request.source,
          expectedOld: intent.expectedRemoteTip,
          newTip: intent.tip,
          fastForwardOnly: true,
        },
      };
    case "pullRequest":
      if (!request.pullRequest)
        throw new Error("An omitted pull request cannot acquire dispatch rights");
      return {
        kind: "ok",
        book: next,
        dispatch: {
          ...ticket,
          action: "createPullRequest",
          source: request.source,
          target: request.target,
          tip: intent.tip,
          marker: commandId,
          ...request.pullRequest,
        },
      };
  }
}

function proofsMatch(book: PublicationBook, proof: ForgeProof) {
  const { intent } = book;
  const { request } = book.progress;
  switch (proof.step) {
    case "branch":
      return (
        sameBranch(request.source, proof.branch) &&
        proof.checkedOutRef === `refs/heads/${request.source.name}` &&
        proof.parent === intent.parent &&
        proof.worktreeId === request.worktreeId
      );
    case "commit":
      return (
        proof.worktreeId === request.worktreeId &&
        sameBranch(proof.branch, request.source) &&
        proof.parent === intent.parent &&
        proof.tree === intent.selectedTree &&
        proof.inBranchHistory &&
        proof.paths.length > 0 &&
        new Set(proof.paths).size === proof.paths.length &&
        proof.oid === intent.tip &&
        proof.paths.every((path) => request.commit?.paths.includes(path)) &&
        (proof.priorEdits.kind === "unknown" ||
          proof.priorEdits.paths.every((path) => proof.paths.includes(path)))
      );
    case "push":
      return sameBranch(request.source, proof.branch) && proof.tip === intent.tip;
    case "pullRequest":
      if (
        !sameBranch(request.source, proof.source) ||
        !sameBranch(request.target, proof.target) ||
        proof.publicationHead !== intent.tip ||
        !Number.isSafeInteger(proof.number) ||
        proof.number < 1
      )
        return false;
      switch (proof.evidence) {
        case "createReply":
          return (
            proof.origin === "created" &&
            (proof.marker === null || proof.marker === book.progress.commandId)
          );
        case "knownNumber":
          return (
            proof.origin === "observed" &&
            (proof.marker === null || proof.marker === book.progress.commandId)
          );
        case "marker":
          return proof.origin === "created" && proof.marker === book.progress.commandId;
        case "currentHead":
          return (
            proof.origin !== "created" && proof.state === "open" && proof.currentHead === intent.tip
          );
        case "member":
          return (
            proof.origin === "observed" &&
            proof.state === "open" &&
            proof.verifiedMember === intent.tip
          );
      }
  }
}
function done(book: PublicationBook, proof: ForgeProof): Result {
  if (!proofsMatch(book, proof)) return reject("wrongProof");
  switch (proof.step) {
    case "branch":
      return writeStep(book, "branch", { kind: "done", proof });
    case "commit":
      return writeStep(book, "commit", { kind: "done", proof });
    case "push":
      return writeStep(book, "push", { kind: "done", proof });
    case "pullRequest":
      return writeStep(book, "pullRequest", { kind: "done", proof });
  }
}

function checkPull(
  book: PublicationBook,
  event: Extract<PublicationEvent, { kind: "preparePull" | "reconcilePull" }>,
): Result {
  const { lookup } = event,
    { request } = book.progress;
  if (!sameBranch(lookup.source, request.source) || !sameBranch(lookup.target, request.target))
    return reject("wrongProof");
  const initial = event.kind === "preparePull";
  type Block = NonNullable<
    Extract<ForgeProgress["steps"]["pullRequest"], { kind: "waiting" }>["blocked"]
  >;
  const blocked = (reason: Block["reason"], numbers: number[] = []): Result =>
    initial
      ? writeStep(book, "pullRequest", { kind: "waiting", blocked: { reason, numbers } })
      : ok(book);
  if (!lookup.complete || lookup.scope !== (initial ? "open" : "all"))
    return blocked("incompleteListing");
  if (initial && lookup.tip !== book.intent.tip) return blocked("headChanged");
  const unique = new Map<number, PullMatch>();
  for (const row of lookup.matches) {
    if (!sameBranch(row.source, request.source) || !sameBranch(row.target, request.target))
      continue;
    const prev = unique.get(row.number);
    if (
      prev &&
      (prev.state !== row.state ||
        prev.marker !== row.marker ||
        prev.currentHead !== row.currentHead ||
        prev.verifiedMember !== row.verifiedMember)
    )
      return blocked("inconsistentListing", [row.number]);
    unique.set(row.number, row);
  }
  const matches = [...unique.values()];
  const open = matches.filter((row) => row.state === "open");
  type Proof = Extract<ForgeProof, { step: "pullRequest" }>;
  const finish = (row: PullMatch, origin: Proof["origin"], evidence: Proof["evidence"]) =>
    done(book, { ...row, step: "pullRequest", origin, evidence, publicationHead: book.intent.tip });
  if (initial) {
    if (open.length > 1)
      return blocked(
        "ambiguous",
        open.map((row) => row.number).sort((a, b) => a - b),
      );
    const row = open[0];
    if (!row) return issueStep(book, "pullRequest", event.attemptId);
    return row.currentHead === book.intent.tip
      ? finish(row, "existing", "currentHead")
      : blocked("headChanged", [row.number]);
  }
  const marked = matches.filter((row) => row.marker === book.progress.commandId);
  if (marked.length > 1) return ok(book);
  const known = event.knownCreation;
  if (known) {
    if (
      known.commandId !== event.commandId ||
      known.attemptId !== event.attemptId ||
      !sameBranch(known.source, request.source) ||
      !sameBranch(known.target, request.target) ||
      known.publicationHead !== book.intent.tip ||
      (marked[0] && marked[0].number !== known.number)
    )
      return ok(book);
    const row = unique.get(known.number);
    if (!row || (row.marker !== null && row.marker !== event.commandId)) return ok(book);
    return finish(row, "observed", "knownNumber");
  }
  if (marked[0]) return finish(marked[0], "created", "marker");
  const row = open[0];
  if (open.length !== 1 || !row || row.marker !== null) return ok(book);
  if (row.currentHead === book.intent.tip) return finish(row, "observed", "currentHead");
  if (row.verifiedMember === book.intent.tip) return finish(row, "observed", "member");
  return ok(book);
}

/** Only the transaction changing waiting to issued may call the external system. Verification never issues a write. */
export function advancePublication(book: PublicationBook, event: PublicationEvent): Result {
  if (event.commandId !== book.progress.commandId) return reject("idConflict");
  const step =
    event.kind === "finishCheckoutAfterFence"
      ? "branch"
      : "proof" in event
        ? event.proof.step
        : "seen" in event
          ? event.seen.step
          : "step" in event
            ? event.step
            : "pullRequest";
  const state = book.progress.steps[step];
  if (event.kind === "issue" || event.kind === "preparePull") {
    const first = order.find((k) => !["done", "skipped"].includes(book.progress.steps[k].kind));
    if (first !== step || state.kind !== "waiting") return reject("invalidState");
    if (event.kind === "preparePull") return checkPull(book, event);
    const seen = event.seen;
    if (
      seen.step === "push" &&
      sameBranch(seen.branch, book.progress.request.source) &&
      seen.remoteTip === book.intent.tip &&
      seen.localTip === book.intent.tip
    )
      return done(book, {
        step: "push",
        branch: book.progress.request.source,
        tip: seen.remoteTip,
        origin: "existing",
      });
    if (!gitPreconditions(book, seen)) return reject("invalidIntent");
    return issueStep(book, step, event.attemptId);
  }
  if (
    state.kind === "done" &&
    (event.kind === "proof" || event.kind === "reconcile" || event.kind === "reconcilePull")
  )
    return ok(book);
  if (state.kind !== "issued" && state.kind !== "verify") return reject("invalidState");
  if (state.attemptId !== event.attemptId) return reject("wrongAttempt");
  switch (event.kind) {
    case "finishCheckoutAfterFence":
      return state.kind === "verify" &&
        event.attemptId !== event.nextAttemptId &&
        event.worktreeId === book.progress.request.worktreeId &&
        sameBranch(book.progress.request.source, event.branch) &&
        event.startedAt === book.intent.parent &&
        event.checkoutParent === book.intent.parent
        ? issueStep(book, "branch", event.nextAttemptId, true)
        : reject("invalidState");
    case "retryGitAfterFence": {
      if (state.kind !== "verify" || event.nextAttemptId === event.attemptId)
        return reject("invalidState");
      const seen = event.seen;
      if (
        seen.step === "push" &&
        sameBranch(seen.branch, book.progress.request.source) &&
        seen.localTip === book.intent.tip &&
        seen.remoteTip === book.intent.tip
      )
        return done(book, {
          step: "push",
          branch: book.progress.request.source,
          tip: seen.remoteTip,
          origin: "observed",
        });
      return gitPreconditions(book, seen)
        ? issueStep(book, step, event.nextAttemptId)
        : reject("invalidState");
    }
    case "lost":
      return writeStep(book, step, {
        kind: "verify",
        attemptId: event.attemptId,
        reason: event.reason,
      });
    case "refused":
      return writeStep(book, step, { kind: "failed", reason: event.reason });
    case "proof":
      if (event.proof.step === "push" && event.proof.origin !== "pushed")
        return reject("wrongProof");
      if (event.proof.step === "pullRequest" && event.proof.evidence !== "createReply")
        return reject("wrongProof");
      return done(book, event.proof);
    case "reconcile":
      if (event.proof.step === "push" && event.proof.origin !== "observed")
        return reject("wrongProof");
      return state.kind === "verify" ? done(book, event.proof) : reject("invalidState");
    case "reconcilePull":
      return state.kind === "verify" ? checkPull(book, event) : reject("invalidState");
  }
}
/** After acquiring the writer lock and fencing the old worker, retain every settled proof and inspect issued effects. */
export function recoverPublication(book: PublicationBook): PublicationBook {
  let recovered = book;
  for (const step of order) {
    const state = book.progress.steps[step];
    if (state.kind === "issued") {
      recovered = {
        ...recovered,
        progress: {
          ...recovered.progress,
          steps: {
            ...recovered.progress.steps,
            [step]: { kind: "verify", attemptId: state.attemptId, reason: "workerInterrupted" },
          },
        },
      };
    }
  }
  return recovered;
}

/** Marks are scoped to a user and provider account as well as the exact host, repository, pull number, head OID and path. */
const markRow = v.strictObject({
  owner: PrincipalIdSchema,
  file: ForgeFileKeySchema,
  version: ObjectVersionSchema,
  mark: ForgeReadMarkSchema,
});
export type ForgeMarkRow = v.InferOutput<typeof markRow>;
const legacyMarkRow = v.strictObject({
  ...markRow.entries,
  file: v.omit(ForgeFileKeySchema, ["headOid"]),
});
/** A historical mark without a head cannot identify a revision. Preserve its record until a fresh read establishes a baseline. */
export function readStoredForgeMark(raw: unknown) {
  const current = v.safeParse(markRow, raw);
  if (current.success) return { kind: "current" as const, row: current.output };
  const old = v.safeParse(legacyMarkRow, raw);
  return old.success
    ? { kind: "noBaseline" as const, legacy: old.output }
    : { kind: "invalid" as const };
}
export type FileMarkReceipt = {
  commandId: CommandId;
  threadId: ForgePublish["threadId"];
  baseVersion: ObjectVersion;
  row: ForgeMarkRow;
};
function sameFile(a: ForgeFileKey, b: ForgeFileKey) {
  return (
    a.accountId === b.accountId &&
    a.path === b.path &&
    a.pull.number === b.pull.number &&
    a.headOid === b.headOid &&
    sameForgeRepository(a.pull.repository, b.pull.repository)
  );
}
function sameMark(a: ForgeReadMark, b: ForgeReadMark) {
  return (
    a.kind === b.kind &&
    (a.kind !== "marked" || (b.kind === "marked" && compareForgeFile(a, b.value).kind === "equal"))
  );
}
/** Commit a saved row with its receipt. On replay return the original receipt and leave the current row alone. */
export function updateForgeMark(
  previous: ForgeMarkRow | null,
  scope: ForgeScope,
  accountId: string,
  commandId: CommandId,
  request: ForgeMarkRequest,
  priorReceipt: FileMarkReceipt | null,
):
  | { kind: "saved"; row: ForgeMarkRow; receipt: FileMarkReceipt }
  | { kind: "replay"; receipt: FileMarkReceipt }
  | {
      kind: "rejected";
      reason: "crossRepository" | "wrongScope" | "versionConflict" | "idConflict";
    } {
  const { file } = request;
  if (!sameForgeRepository(file.pull.repository, scope.repository))
    return { kind: "rejected", reason: "crossRepository" };
  if (
    request.threadId !== scope.threadId ||
    file.accountId !== accountId ||
    (previous && (previous.owner !== scope.owner || !sameFile(previous.file, file)))
  )
    return { kind: "rejected", reason: "wrongScope" };
  if (priorReceipt) {
    if (
      priorReceipt.commandId !== commandId ||
      priorReceipt.threadId !== request.threadId ||
      priorReceipt.row.owner !== scope.owner ||
      !sameFile(priorReceipt.row.file, file) ||
      priorReceipt.baseVersion !== request.baseVersion ||
      !sameMark(priorReceipt.row.mark, request.mark)
    )
      return { kind: "rejected", reason: "idConflict" };
    return { kind: "replay", receipt: priorReceipt };
  }
  if (request.baseVersion !== (previous?.version ?? "0"))
    return { kind: "rejected", reason: "versionConflict" };
  const row = {
    owner: scope.owner,
    file,
    mark: request.mark,
    version: v.parse(ObjectVersionSchema, String(BigInt(request.baseVersion) + 1n)),
  };
  return {
    kind: "saved",
    row,
    receipt: { row, commandId, threadId: request.threadId, baseVersion: request.baseVersion },
  };
}
