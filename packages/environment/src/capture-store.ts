import { readManaged } from "./worktree-storage";
import { measureCaptureBoundary } from "./capture-timing";
import { dirname, join, relative, resolve, sep } from "node:path";
import { lstatSync, rmSync } from "node:fs";
import {
  FileOwnershipSchema,
  CaptureIdSchema,
  DirectoryBindingSchema,
  GitObjectIdSchema,
  CheckpointCaptureSchema,
  CheckpointResultSchema,
  comparePositions,
  NativeItemIdSchema,
  ObjectVersionSchema,
  type CheckpointCapture,
  type DiffRequest,
  type Thread,
  type Round,
  type CaptureId,
  type FileOwnership,
  type DirectoryBinding,
} from "@kraka/protocol";
import * as v from "valibot";
import {
  beginCapture,
  captureDirectory,
  checkpointRef,
  attributeFile,
  transitionCapture,
  type CaptureState,
  type CaptureEvent,
  type Boundary,
  type PathObservation,
} from "./checkpoints";
import { captureBoundary, captureLayout, decodeSeal, type CaptureHook } from "./capture-boundary";
import {
  openCaptureStorage,
  bindCaptureSource,
  readIntent,
  pendingBaselines,
  type CaptureIntent,
} from "./capture-storage";
import { DirectoryWriters, type LeaseKey } from "./directory-lease";
import { physicalDirectory } from "./project-directory";
import { readThread, readRound, type FirstSendStore } from "./first-send-store";
import { advanceQueue } from "./input-store";
import { transitionRound } from "./round";
import {
  compareCaptureFiles,
  type ResolvedDiffDirectory,
  type EndpointPair,
  type DiffActor,
  type LocalDiffService,
} from "./local-diff";
import { resolveDiffDirectory } from "./git-workspace";
import { gitRepositoryIdentity, gitProcessError, runGit } from "./git-process";

const version = v.parse(ObjectVersionSchema, "1");
const sourceSchema = v.object({
  realPath: v.string(),
  identity: v.string(),
  writer: v.optional(v.string()),
});
function captureSource(text: string) {
  const { writer, ...repo } = v.parse(sourceSchema, JSON.parse(text));
  return { writer, repo };
}
function storedCheckpointRef(
  path: string,
  key: Pick<CaptureState["key"], "id" | "threadId" | "writer" | "environmentId">,
  boundary: Boundary,
  legacy: boolean,
) {
  const ref = checkpointRef(key, boundary);
  if (!legacy || runGit(path, ["show-ref", "--exists", ref]).exitCode !== 2) return ref;
  const { writer, ...oldKey } = key;
  return checkpointRef(oldKey, boundary);
}
const ownersSchema = v.array(v.tuple([v.string(), FileOwnershipSchema]));
function apply(state: CaptureState, event: CaptureEvent) {
  const next = transitionCapture(state, event);
  if (next.kind === "rejected") throw Error(next.reason);
  return next.value;
}
function enclosingCheckout(path: string) {
  for (let p = path; ; p = dirname(p)) {
    if (lstatSync(join(p, ".git"), { throwIfNoEntry: false })) return true;
    if (p === dirname(p)) return false;
  }
}
export class RoundCaptures {
  readonly writers: DirectoryWriters;
  hook?: CaptureHook;
  signal?: AbortSignal;
  constructor(private readonly store: FirstSendStore) {
    openCaptureStorage(store.db);
    this.writers = new DirectoryWriters(store.writer.stateDirectory, (key) =>
      this.resolveLease(key),
    );
  }
  private resolveLease(key: LeaseKey) {
    if (key.environmentId !== this.store.writer.environmentId) return null;
    const thread = this.store.db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM threads WHERE json_extract(data,'$.directory.directoryId')=? AND json_extract(data,'$.directory.generation')=? LIMIT 1",
      )
      .get(key.directoryId, key.generation);
    const t = thread && readThread(this.store.db, thread.id);
    const path = t && this.store.directory(t);
    return path ? physicalDirectory(path) : null;
  }
  id(round: Round) {
    const row = readIntent(this.store.db, round.id, round.attempt.attemptId);
    if (row) return v.parse(CaptureIdSchema, row.id);
    const current = readRound(this.store.db, round.id);
    const phase =
      current?.attempts?.find((a) => a.attemptId === round.attempt.attemptId)?.phase ??
      round.attempt.phase;
    return "captureId" in phase ? phase.captureId : v.parse(CaptureIdSchema, crypto.randomUUID());
  }
  private initial(round: Round, binding: DirectoryBinding, id: CaptureId) {
    return beginCapture({
      writer: this.store.gitPaths.writer,
      environmentId: this.store.writer.environmentId,
      id,
      roundId: round.id,
      attemptId: round.attempt.attemptId,
      threadId: round.threadId,
      worktreeId: binding.kind === "managedWorktree" ? binding.worktreeId : null,
      ...(binding.kind === "projectRoot" ? { projectRoot: binding } : {}),
    });
  }
  private clean(path: string) {
    try {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !(error instanceof Error) ||
        !("code" in error) ||
        !["EBUSY", "EPERM", "ENOTEMPTY"].includes(String(error.code))
      )
        throw error;
      // The cleanup row was committed with the boundary. Restart can finish it.
      console.warn("Checkpoint scratch cleanup deferred", error.message);
      return;
    }
    this.store.db.run("DELETE FROM capture_cleanup WHERE path=?", [path]);
  }
  // A project can register the same physical checkout as a managed worktree.
  // Read its saved identity here; validation against disk belongs inside the lease.
  private recoveryDirectory(thread: Thread) {
    const identity = thread.worktreeId
      ? readManaged(this.store.db, thread.worktreeId)?.disk?.identity
      : this.store.db
          .query<{ identity: string }, [string]>("SELECT identity FROM projects WHERE id=?")
          .get(thread.projectId)?.identity;
    return identity ?? thread.directory?.directoryId ?? thread.id;
  }

  waitForRecovery(threadId: Thread["id"]) {
    if (!this.store.recovery.pending) return;
    const thread = readThread(this.store.db, threadId);
    return thread && this.store.recovery.wait(this.recoveryDirectory(thread));
  }

  registerRecovery(closing: Round[]) {
    const recovery = this.store.recovery;
    for (const { path } of this.store.db
      .query<{ path: string }, []>("SELECT path FROM capture_cleanup")
      .all())
      recovery.register("capture-scratch", () => this.clean(path));
    for (const row of pendingBaselines(this.store.db)) {
      const round = readRound(this.store.db, row.round);
      const thread = round && readThread(this.store.db, round.threadId);
      if (round?.attempt.attemptId === row.attempt && thread)
        recovery.register(this.recoveryDirectory(thread), async () => {
          const active = readRound(this.store.db, round.id);
          const current = readIntent(this.store.db, round.id, row.attempt);
          if (
            active?.attempt.attemptId === row.attempt &&
            current &&
            !current.baseline &&
            !current.failure
          )
            await this.boundary(active, thread, current, "before", true);
        });
    }
    for (const round of closing) {
      const thread = readThread(this.store.db, round.threadId);
      if (!thread) throw Error("Unknown capture thread");
      recovery.register(this.recoveryDirectory(thread), async () => {
        const current = readRound(this.store.db, round.id);
        if (current?.attempt.attemptId === round.attempt.attemptId)
          await this.finish(current, true);
      });
    }
  }

  async before(round: Round) {
    const db = this.store.db,
      thread = readThread(db, round.threadId),
      binding = thread?.directory;
    if (!thread || !binding) return;
    const attempt = round.attempt.attemptId;
    const intent = db.transaction(() => {
      let row = readIntent(db, round.id, attempt);
      if (!row) {
        db.run("INSERT INTO capture_intents(round,attempt,id,source) VALUES(?,?,?,?)", [
          round.id,
          attempt,
          crypto.randomUUID(),
          bindCaptureSource(db, binding, null),
        ]);
        row = readIntent(db, round.id, attempt);
      }
      return row;
    })();
    if (intent && !intent.baseline && !intent.failure)
      await this.boundary(round, thread, intent, "before", round.attempt.phase.kind !== "filed");
  }
  async finish(round: Round, recover: boolean) {
    const phase = round.attempt.phase;
    if (phase.kind !== "closing") return;
    const row = readIntent(this.store.db, round.id, round.attempt.attemptId);
    if (row && row.id !== phase.captureId) throw Error("wrongCapture");
    if (!row || row.failure) {
      const result = row?.failure
        ? v.parse(CheckpointResultSchema, JSON.parse(row.failure))
        : { kind: "missing" as const, boundary: "before" as const, reason: "baselineMissing" };
      this.store.db.transaction(() =>
        this.settle(round, {
          id: phase.captureId,
          roundId: round.id,
          attemptId: round.attempt.attemptId,
          version,
          result,
        }),
      )();
      return;
    }
    const thread = readThread(this.store.db, round.threadId);
    if (!thread) throw Error("Unknown capture thread");
    await this.boundary(round, thread, row, "after", recover);
  }
  private settle(round: Round, capture: CheckpointCapture) {
    const current = readRound(this.store.db, round.id);
    if (
      current?.attempt.phase.kind === "finished" &&
      current.attempt.phase.captureId === capture.id
    )
      return;
    if (
      !current ||
      current.threadId !== round.threadId ||
      current.attempt.attemptId !== capture.attemptId ||
      capture.roundId !== current.id
    )
      throw Error("wrongAttempt");
    const next = transitionRound(current.attempt, {
      ...current.attempt,
      kind: "captureSettled",
      capture,
    });
    if (next.kind !== "ok") throw Error(next.reason);
    this.store.setPhase(current, next.value, capture);
    advanceQueue(this.store, current.threadId);
  }
  private observations(round: Round, directory: string): PathObservation[] {
    const result: PathObservation[] = [];
    for (const { data } of this.store.db
      .query<{ data: string }, [string, string]>(
        "SELECT data FROM tool_activity_scoped_changes WHERE thread_id=? AND json_extract(data,'$.attemptId')=?",
      )
      .all(round.threadId, round.attempt.attemptId)) {
      const row = JSON.parse(data);
      const id = v.safeParse(NativeItemIdSchema, row.itemId);
      if (!id.success) continue;
      for (const path of [row.path, row.destination])
        if (typeof path === "string")
          result.push({
            threadId: round.threadId,
            roundId: round.id,
            attemptId: round.attempt.attemptId,
            itemId: id.output,
            path: relative(directory, resolve(directory, path)).split(sep).join("/"),
          });
    }
    return result;
  }
  private boundary(
    round: Round,
    thread: Thread,
    row: CaptureIntent,
    boundary: Boundary,
    recover: boolean,
  ) {
    return measureCaptureBoundary(boundary, () =>
      this.runBoundary(round, thread, row, boundary, recover),
    );
  }
  private async runBoundary(
    round: Round,
    thread: Thread,
    row: CaptureIntent,
    boundary: Boundary,
    recover: boolean,
  ) {
    const db = this.store.db,
      binding = v.parse(DirectoryBindingSchema, JSON.parse(row.binding));
    let state = this.initial(round, binding, v.parse(CaptureIdSchema, row.id));
    const key = state.key;
    const ids = { id: key.id, attemptId: key.attemptId };
    const scratch = this.store.gitPaths.captureScratch;
    let tmp = join(scratch, captureDirectory(key, boundary));
    const queueCleanup = () => db.run("INSERT OR IGNORE INTO capture_cleanup VALUES(?)", [tmp]);
    const settled = (capture: CheckpointCapture, owners?: Map<string, FileOwnership>) => {
      if (boundary === "before") {
        db.run("UPDATE capture_intents SET failure=?,seal=NULL WHERE round=? AND attempt=?", [
          JSON.stringify(capture.result),
          round.id,
          key.attemptId,
        ]);
      } else {
        if (row.baseline && row.repo)
          db.run("INSERT INTO round_captures(id,source,partial_before,owners) VALUES(?,?,?,?)", [
            row.id,
            row.source,
            capture.result.kind === "ready" ? null : row.baseline,
            owners?.size ? JSON.stringify([...owners]) : null,
          ]);
        this.settle(round, capture);
      }
      queueCleanup();
    };
    try {
      const source = row.repo ? captureSource(row.repo) : null;
      if (source?.writer && source.writer !== key.writer) throw Error("sourceRepositoryChanged");
      const seal = row.seal ? decodeSeal(row.seal) : null;
      const layout = captureLayout(scratch, key, boundary, seal);
      if (layout === "legacy") tmp = join(scratch, captureDirectory(key, boundary, layout));
      if (!Bun.deepEquals(binding, thread.directory)) throw Error("directoryLost");
      const path = this.store.directory(thread);
      if (!path) throw Error("directoryLost");
      if (!enclosingCheckout(path)) throw Error("noRepository");
      const operationId = row.id + "/" + boundary;
      await this.writers.withDirectoryLease(
        {
          environmentId: this.store.writer.environmentId,
          directoryId: binding.directoryId,
          generation: binding.generation,
          operationId,
        },
        async (lease) => {
          if (this.store.directory(readThread(db, thread.id) ?? thread) !== lease.path)
            throw Error("directoryLost");
          if (boundary === "after") {
            if (
              !row.baseline ||
              !source ||
              !Bun.deepEquals(gitRepositoryIdentity(path), source.repo)
            )
              throw Error("baselineUnavailable");
            const ref = storedCheckpointRef(path, key, "before", !source.writer),
              commit = v.parse(GitObjectIdSchema, row.baseline);
            const found = await lease.git([
              "--no-replace-objects",
              "rev-parse",
              ref,
              commit + "^{tree}",
            ]);
            const [actual, tree] = found.stdout.toString().trim().split(/\r?\n/);
            if (found.exitCode !== 0) throw gitProcessError("baseline.verify", found);
            if (actual !== commit) throw Error("baselineUnavailable");
            const working = apply(state, {
              ...ids,
              kind: "baselinePublished",
              point: {
                ref: checkpointRef(key, "before"),
                commit,
                tree: v.parse(GitObjectIdSchema, tree),
              },
            });
            state = apply(working, { ...ids, kind: "rootEnded" });
          }
          const { point } = await captureBoundary({
            captureKey: state,
            boundary,
            directoryBinding: binding,
            lease,
            scratch,
            layout,
            seal,
            recover,
            source: source?.repo ?? null,
            ...(recover &&
              source &&
              !source.writer && {
                legacyRef: checkpointRef(
                  {
                    environmentId: this.store.writer.environmentId,
                    threadId: thread.id,
                    id: key.id,
                  },
                  boundary,
                ),
              }),
            bindSource: (repo) => {
              if (!row.repo) {
                const saved = { ...repo, writer: this.store.gitPaths.writer };
                row.source = bindCaptureSource(db, binding, saved);
                row.repo = JSON.stringify(saved);
                db.run("UPDATE capture_intents SET source=? WHERE round=? AND attempt=?", [
                  row.source,
                  round.id,
                  row.attempt,
                ]);
              }
            },
            remember: (seal) =>
              db.run("UPDATE capture_intents SET seal=? WHERE round=? AND attempt=?", [
                JSON.stringify(seal),
                round.id,
                row.attempt,
              ]),
            hook: this.hook,
          });
          if (lease.revalidate(lease.key) !== "current") throw Error("directoryLost");
          const verifyPoint = async () => {
            const actual = await lease.git(["rev-parse", point.ref, point.ref + "^{tree}"]);
            if (actual.exitCode !== 0) throw gitProcessError("tree.verify", actual);
            if (
              actual.stdout.toString().trim().split(/\r?\n/).join(" ") !==
              point.commit + " " + point.tree
            )
              throw Error("idConflict", {
                cause: "tree.verify: ref or tree differs from the sealed publication",
              });
          };
          if (boundary === "before") {
            await verifyPoint();
            const working = apply(state, { ...ids, kind: "baselinePublished", point });
            if (working.kind !== "working") throw Error("invalidState");
            db.transaction(() => {
              db.run(
                "UPDATE capture_intents SET baseline=?,seal=NULL WHERE round=? AND attempt=?",
                [working.baseline.commit, round.id, row.attempt],
              );
              queueCleanup();
            })();
            return;
          }
          if (state.kind !== "after") throw Error("invalidState");
          const query = {
            kind: "round" as const,
            threadId: thread.id,
            captureId: ids.id,
            ...(binding.kind === "managedWorktree"
              ? { worktreeId: binding.worktreeId }
              : { directoryId: binding.directoryId, generation: binding.generation }),
          };
          const dir = resolveDiffDirectory(this.store, query);
          if (!dir) throw Error("directoryLost");
          const owners = new Map<string, FileOwnership>();
          let comparison: Extract<CaptureEvent, { kind: "endPublished" }>["comparison"];
          try {
            await this.hook?.("summary", boundary, state);
            const files =
              state.baseline.tree === point.tree
                ? []
                : compareCaptureFiles(dir, state.baseline.tree, point.tree);
            const observations = this.observations(round, path);
            const shared =
              binding.kind === "projectRoot" ||
              !!db
                .query(
                  "SELECT 1 FROM threads WHERE id<>? AND json_extract(data,'$.directory.directoryId')=? LIMIT 1",
                )
                .get(thread.id, binding.directoryId);
            for (const f of files) {
              const owner = attributeFile(
                f.path,
                observations,
                shared ? "sharedWriter" : "complete",
              );
              f.owner =
                f.previousPath &&
                !Bun.deepEquals(
                  owner,
                  attributeFile(f.previousPath, observations, shared ? "sharedWriter" : "complete"),
                )
                  ? { kind: "unknown", reason: "overlap" }
                  : owner;
              if (
                f.owner.kind === "observed" ||
                f.owner.reason !==
                  (binding.kind === "projectRoot" ? "sharedWriter" : "noObservation")
              )
                owners.set(f.path, f.owner);
            }
            comparison = { kind: "compared", files };
          } catch {
            comparison = { kind: "unknown", reason: "summaryUnavailable" };
          }
          await verifyPoint();
          const ready = apply(state, { ...ids, kind: "endPublished", point, version, comparison });
          if (ready.kind !== "settled") throw Error("invalidState");
          db.transaction(() => settled(ready.capture, owners))();
        },
        this.signal,
      );
    } catch (error) {
      // A closing writer leaves its existing intent and sealed objects for the next restart.
      if (recover && this.signal?.aborted) return;
      const reason = error instanceof Error ? error.message : "captureFailed";
      if (reason !== "noRepository")
        console.error(
          "Checkpoint capture failed",
          JSON.stringify({
            id: key.id,
            boundary,
            reason,
            detail:
              error instanceof Error && error.cause !== undefined
                ? String(error.cause).slice(-2048)
                : undefined,
          }),
        );
      db.transaction(() =>
        settled({
          id: key.id,
          roundId: round.id,
          attemptId: key.attemptId,
          version,
          result: { kind: reason === "noRepository" ? "missing" : "error", boundary, reason },
        }),
      )();
    }
    this.clean(tmp);
    await this.hook?.("settled", boundary, state);
  }

  readCaptureRange(input: {
    thread: Thread["id"];
    worktree: ResolvedDiffDirectory;
    fromCaptureId: CaptureId;
    toCaptureId: CaptureId;
    cursor: string | null;
    single: boolean;
    actor: DiffActor;
    reader: LocalDiffService;
  }) {
    const { thread, worktree, fromCaptureId, toCaptureId, cursor, actor, reader } = input;
    const binding = worktree.address;
    const address =
      binding.kind === "managedWorktree"
        ? { threadId: thread, worktreeId: binding.worktreeId }
        : { threadId: thread, directoryId: binding.directoryId, generation: binding.generation };
    const query: DiffRequest = input.single
      ? { kind: "round", ...address, captureId: toCaptureId }
      : { kind: "roundRange", ...address, fromCaptureId, toCaptureId };
    return reader.readLocalDiff({
      actor,
      query,
      cursor,
      resolvedDirectory: worktree,
      captureRange: () => this.endpoints(thread, worktree, fromCaptureId, toCaptureId),
    });
  }
  private endpoints(
    thread: Thread["id"],
    worktree: ResolvedDiffDirectory,
    fromCaptureId: CaptureId,
    toCaptureId: CaptureId,
  ) {
    const find = (id: CaptureId) => {
      const row = this.store.db
        .query<
          {
            created: string;
            payload: string;
            binding: string;
            repo: string;
            partial_before: string | null;
            owners: string | null;
          },
          [string, string, string]
        >(
          "SELECT j.created,j.payload,s.binding,s.repo,c.partial_before,c.owners FROM sync_rows j JOIN round_captures c ON c.id=? JOIN capture_sources s ON s.id=c.source WHERE j.source=? AND j.key=? AND j.payload IS NOT NULL",
        )
        .get(id, thread, JSON.stringify(["checkpointCapture", id]));
      if (!row) return null;
      const capture = v.parse(CheckpointCaptureSchema, JSON.parse(row.payload).value);
      const b = v.parse(DirectoryBindingSchema, JSON.parse(row.binding)),
        a = worktree.address;
      if (
        b.kind !== a.kind ||
        b.directoryId !== a.directoryId ||
        b.generation !== a.generation ||
        (b.kind === "managedWorktree" &&
          a.kind === "managedWorktree" &&
          b.worktreeId !== a.worktreeId)
      )
        return null;
      const round = readRound(this.store.db, capture.roundId);
      if (round?.attempt.phase.kind !== "finished" || round.attempt.phase.captureId !== id)
        return null;
      const pair = capture.result.kind === "ready" ? capture.result.comparison : null;
      return { ...row, baseline: pair?.before ?? row.partial_before, end: pair?.after ?? null };
    };
    const first = find(fromCaptureId),
      last = fromCaptureId === toCaptureId ? first : find(toCaptureId);
    const physicalRepo = gitRepositoryIdentity(worktree.path);
    const point = (row: ReturnType<typeof find>, boundary: Boundary, id: CaptureId) => {
      const data = boundary === "before" ? row?.baseline : row?.end;
      if (!row?.repo || !data) return null;
      const source = captureSource(row.repo);
      if (
        (source.writer && source.writer !== this.store.gitPaths.writer) ||
        !Bun.deepEquals(physicalRepo, source.repo)
      )
        return null;
      const commit = v.parse(GitObjectIdSchema, data);
      const ref = storedCheckpointRef(
        worktree.path,
        {
          writer: this.store.gitPaths.writer,
          environmentId: this.store.writer.environmentId,
          threadId: thread,
          id,
        },
        boundary,
        !source.writer,
      );
      const r = runGit(worktree.path, ["rev-parse", "--verify", ref]);
      const t = runGit(worktree.path, [
        "--no-replace-objects",
        "rev-parse",
        "--verify",
        commit + "^{tree}",
      ]);
      return r.exitCode === 0 && t.exitCode === 0 && r.stdout.toString().trim() === commit
        ? { commit, tree: v.parse(GitObjectIdSchema, t.stdout.toString().trim()) }
        : null;
    };
    const a = point(first, "before", fromCaptureId),
      b = point(last, "after", toCaptureId);
    const from = a
      ? {
          kind: "round" as const,
          captureId: fromCaptureId,
          boundary: "before" as const,
          commit: a.commit,
        }
      : null;
    const to = b
      ? {
          kind: "round" as const,
          captureId: toCaptureId,
          boundary: "after" as const,
          commit: b.commit,
        }
      : null;
    if (
      !physicalRepo ||
      !first ||
      !last ||
      !from ||
      !to ||
      !a ||
      !b ||
      comparePositions(first.created, last.created) > 0 ||
      !first.end ||
      !last.baseline
    )
      return { reason: "captureRangeUnavailable", from, to };
    const pair: EndpointPair = {
      repository: physicalRepo,
      from,
      to,
      fromTree: a.tree,
      toTree: b.tree,
    };
    return {
      pair,
      owners: new Map(
        first === last && first.owners ? v.parse(ownersSchema, JSON.parse(first.owners)) : [],
      ),
    };
  }
}
