import { dirname, join, relative, resolve, sep } from "node:path";
import { lstatSync, rmSync } from "node:fs";
import {
  FileOwnershipSchema,
  CaptureIdSchema,
  DirectoryBindingSchema,
  GitObjectIdSchema,
  CheckpointCaptureSchema,
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
  captureWorkspace,
  checkpointRef,
  attributeFile,
  transitionCapture,
  type CaptureState,
  type CaptureEvent,
  type Boundary,
  type PathObservation,
} from "./checkpoints";
import { captureBoundary, decodeSeal, type CaptureHook } from "./capture-boundary";
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
import { gitRepositoryIdentity, runGit } from "./git-process";

const version = v.parse(ObjectVersionSchema, "1");
const publication = v.strictObject({
  ref: v.string(),
  commit: GitObjectIdSchema,
  tree: GitObjectIdSchema,
});
const physical = v.strictObject({ realPath: v.string(), identity: v.string() });
const ownersSchema = v.array(v.tuple([v.string(), FileOwnershipSchema]));
type Stored = {
  seq: number;
  id: string;
  thread: string;
  round: string;
  attempt: string;
  binding: string;
  repo: string | null;
  baseline: string | null;
  end: string | null;
  seal: string | null;
  result: string | null;
  owners: string | null;
  scratch: string | null;
};
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
    store.db.exec(`CREATE TABLE IF NOT EXISTS round_captures(seq INTEGER PRIMARY KEY,id TEXT NOT NULL UNIQUE,thread TEXT NOT NULL,round TEXT NOT NULL,attempt TEXT NOT NULL UNIQUE,binding TEXT NOT NULL,repo TEXT,baseline TEXT,end TEXT,seal TEXT,result TEXT,owners TEXT,scratch TEXT,cleanup INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS capture_pending_baseline ON round_captures(seq) WHERE baseline IS NULL AND result IS NULL;
    CREATE INDEX IF NOT EXISTS capture_scratch ON round_captures(seq) WHERE scratch IS NOT NULL;`);
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
  private row(attempt: string) {
    return this.store.db
      .query<Stored, [string]>("SELECT * FROM round_captures WHERE attempt=?")
      .get(attempt);
  }
  id(round: Round) {
    const row = this.row(round.attempt.attemptId);
    const phase = round.attempt.phase;
    return v.parse(
      CaptureIdSchema,
      row?.id ?? ("captureId" in phase ? phase.captureId : crypto.randomUUID()),
    );
  }
  private initial(round: Round, binding: DirectoryBinding, id: CaptureId) {
    return beginCapture({
      environmentId: this.store.writer.environmentId,
      id,
      roundId: round.id,
      attemptId: round.attempt.attemptId,
      threadId: round.threadId,
      worktreeId: binding.kind === "managedWorktree" ? binding.worktreeId : null,
      ...(binding.kind === "projectRoot" ? { projectRoot: binding } : {}),
    });
  }
  private state(row: Stored, round: Round, binding: DirectoryBinding, boundary: Boundary) {
    const state = this.initial(round, binding, v.parse(CaptureIdSchema, row.id));
    if (boundary === "before") return state;
    if (!row.baseline) throw Error("baselineMissing");
    const ids = { id: state.key.id, attemptId: state.key.attemptId };
    const baseline = apply(state, {
      ...ids,
      kind: "baselinePublished",
      point: v.parse(publication, JSON.parse(row.baseline)),
    });
    return apply(baseline, { ...ids, kind: "rootEnded" });
  }
  private clean(row: Pick<Stored, "id" | "scratch">) {
    if (!row.scratch) return;
    rmSync(row.scratch, { recursive: true, force: true });
    this.store.db.run("UPDATE round_captures SET scratch=NULL,cleanup=0 WHERE id=?", [row.id]);
  }
  cleanSettled() {
    for (const row of this.store.db
      .query<Stored, []>("SELECT * FROM round_captures WHERE scratch IS NOT NULL AND cleanup=1")
      .all())
      this.clean(row);
  }
  async recoverBaselines() {
    const rows = this.store.db
      .query<Stored, []>("SELECT * FROM round_captures WHERE baseline IS NULL AND result IS NULL")
      .all();
    for (const row of rows) {
      const round = readRound(this.store.db, row.round),
        thread = readThread(this.store.db, row.thread);
      if (round && thread && round.attempt.attemptId === row.attempt)
        await this.boundary(round, thread, row, "before", true);
    }
  }
  async before(round: Round) {
    const thread = readThread(this.store.db, round.threadId);
    const binding = thread?.directory;
    if (!thread || !binding) return;
    const attempt = round.attempt.attemptId;
    let row = this.row(attempt);
    if (!row) {
      this.store.db.run(
        "INSERT INTO round_captures(id,thread,round,attempt,binding) VALUES(?,?,?,?,?)",
        [crypto.randomUUID(), thread.id, round.id, attempt, JSON.stringify(binding)],
      );
      row = this.row(attempt);
    }
    if (!row || row.baseline || row.result) return;
    await this.boundary(round, thread, row, "before", round.attempt.phase.kind !== "filed");
  }
  async finish(round: Round, recover: boolean) {
    const phase = round.attempt.phase;
    if (phase.kind !== "closing") return;
    const row = this.row(round.attempt.attemptId);
    if (row && row.id !== phase.captureId) throw Error("wrongCapture");
    if (!row || row.result) {
      const capture = row?.result
        ? v.parse(CheckpointCaptureSchema, JSON.parse(row.result))
        : v.parse(CheckpointCaptureSchema, {
            id: phase.captureId,
            roundId: round.id,
            attemptId: round.attempt.attemptId,
            version,
            result: { kind: "missing", boundary: "before", reason: "baselineMissing" },
          });
      this.store.db.transaction(() => this.settle(round, capture))();
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
  private async boundary(
    round: Round,
    thread: Thread,
    row: Stored,
    boundary: Boundary,
    recover: boolean,
  ) {
    const db = this.store.db,
      binding = v.parse(DirectoryBindingSchema, JSON.parse(row.binding));
    const state = this.state(row, round, binding, boundary);
    const ids = { id: state.key.id, attemptId: state.key.attemptId };
    const plan = captureWorkspace(state);
    const scratch = join(this.store.writer.stateDirectory, "capture-scratch");
    const write = (next: CaptureState, owners?: Map<string, FileOwnership>) => {
      db.transaction(() => {
        if (next.kind === "working")
          db.run("UPDATE round_captures SET baseline=?,seal=NULL,cleanup=1 WHERE id=?", [
            JSON.stringify(next.baseline),
            row.id,
          ]);
        else if (next.kind === "settled") {
          db.run(
            "UPDATE round_captures SET end=?,result=?,owners=?,seal=NULL,cleanup=1 WHERE id=?",
            [
              next.end ? JSON.stringify(next.end) : null,
              JSON.stringify(next.capture),
              owners?.size ? JSON.stringify([...owners]) : null,
              row.id,
            ],
          );
          if (boundary === "after") this.settle(round, next.capture);
        }
      })();
      this.store.sync.notify();
    };
    try {
      if (!plan || !Bun.deepEquals(binding, thread.directory)) throw Error("directoryLost");
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
          const tmp = dirname(join(scratch, plan.privateIndexPath));
          row.scratch = tmp;
          db.run("UPDATE round_captures SET scratch=?,cleanup=0 WHERE id=?", [tmp, row.id]);
          const { point } = await captureBoundary({
            captureKey: state,
            boundary,
            directoryBinding: binding,
            lease,
            scratch,
            seal: row.seal ? decodeSeal(row.seal) : null,
            recover,
            source: row.repo ? v.parse(physical, JSON.parse(row.repo)) : null,
            bindSource: (repo) => {
              if (!row.repo)
                db.run("UPDATE round_captures SET repo=? WHERE id=?", [
                  JSON.stringify(repo),
                  row.id,
                ]);
            },
            remember: (seal) => {
              db.run("UPDATE round_captures SET seal=? WHERE id=?", [JSON.stringify(seal), row.id]);
            },
            hook: this.hook,
          });
          if (lease.revalidate(lease.key) !== "current") throw Error("directoryLost");
          const verifyPoint = async () => {
            const actual = await lease.git(["rev-parse", point.ref, point.ref + "^{tree}"]);
            if (
              actual.exitCode !== 0 ||
              actual.stdout.toString().trim().split(/\r?\n/).join(" ") !==
                point.commit + " " + point.tree
            )
              throw Error("idConflict");
          };
          if (boundary === "before") {
            await verifyPoint();
            write(apply(state, { ...ids, kind: "baselinePublished", point }));
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
            const files = compareCaptureFiles(dir, state.baseline.tree, point.tree);
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
          write(apply(state, { ...ids, kind: "endPublished", point, version, comparison }), owners);
        },
        this.signal,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : "captureFailed";
      write(
        apply(state, {
          ...ids,
          kind: reason === "noRepository" ? "missing" : "error",
          boundary,
          reason,
          version,
        }),
      );
    }
    this.clean(row);
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
        .query<Stored, [string, string]>("SELECT * FROM round_captures WHERE id=? AND thread=?")
        .get(id, thread);
      if (!row || !row.result || !row.repo) return null;
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
      const round = readRound(this.store.db, row.round);
      if (round?.attempt.phase.kind !== "finished" || round.attempt.phase.captureId !== id)
        return null;
      return row;
    };
    const first = find(fromCaptureId),
      last = fromCaptureId === toCaptureId ? first : find(toCaptureId);
    const physicalRepo = gitRepositoryIdentity(worktree.path);
    const point = (row: Stored | null, boundary: Boundary, id: CaptureId) => {
      const data = boundary === "before" ? row?.baseline : row?.end;
      if (!row?.repo || !data || !Bun.deepEquals(physicalRepo, JSON.parse(row.repo))) return null;
      const p = v.parse(publication, JSON.parse(data));
      const ref = checkpointRef(
        { environmentId: this.store.writer.environmentId, threadId: thread, id },
        boundary,
      );
      const r = runGit(worktree.path, ["rev-parse", "--verify", ref]);
      const t = runGit(worktree.path, ["rev-parse", "--verify", p.commit + "^{tree}"]);
      return r.exitCode === 0 &&
        t.exitCode === 0 &&
        r.stdout.toString().trim() === p.commit &&
        t.stdout.toString().trim() === p.tree
        ? p
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
      first.seq > last.seq ||
      first.repo !== last.repo ||
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
