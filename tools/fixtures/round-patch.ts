import assert from "node:assert/strict";
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { type CheckpointCapture, type Round, type CaptureId, type ThreadId } from "@kraka/protocol";
import { openReceiptReader } from "@kraka/environment";
import { CaptureBarriers, runCodexCase } from "./codex-resume";
import { accepted, productRoot } from "./first-send";
import { git } from "./isolated-start";
export type PatchHost = Parameters<Parameters<typeof runCodexCase>[1]>[0];
export type Reader = Awaited<ReturnType<PatchHost["patchReader"]>>;
export function patchCase(
  run: (s: PatchHost, b: CaptureBarriers) => Promise<void>,
  repo = true,
  root = productRoot,
) {
  const b = new CaptureBarriers();
  return runCodexCase(
    "ask",
    async (s) => {
      try {
        await run(s, b);
      } catch (error) {
        const diagnostic: {
          daemonStderr: string[];
          stages: typeof b.events.items;
          captures: unknown[];
          pending: unknown[];
          readError?: string;
        } = { daemonStderr: s.stderrTails(), stages: b.events.items, captures: [], pending: [] };
        try {
          const db = openReceiptReader(s.state);
          try {
            diagnostic.captures = db
              .query<{ payload: string }, []>(
                "SELECT payload FROM sync_rows WHERE json_extract(key,'$[0]')='checkpointCapture' AND payload IS NOT NULL",
              )
              .all()
              .map((r) => JSON.parse(r.payload).value);
            diagnostic.pending = db
              .query<{ id: string; round: string; attempt: string; failure: string | null }, []>(
                "SELECT id,round,attempt,failure FROM capture_intents",
              )
              .all()
              .map((r) => ({ ...r, failure: r.failure ? JSON.parse(r.failure) : null }));
          } finally {
            db.close(true);
          }
        } catch (readError) {
          diagnostic.readError = String(readError);
        }
        console.error("Round patch fixture failure", JSON.stringify(diagnostic));
        throw error;
      } finally {
        if (b.hold && b.writer?.child.exitCode === null && b.writer.child.signalCode === null) {
          b.hold = null;
          for (const e of b.events.items) b.release(e.token);
        }
      }
    },
    root,
    { git: repo, barriers: b },
  );
}
export function address(s: PatchHost, threadId: ThreadId) {
  const r = s.f.project.root;
  assert.ok(r);
  return { threadId, directoryId: r.directoryId, generation: r.generation };
}
export async function finished(reader: Reader, roundId: Round["id"]) {
  const snap = await reader.snapshots.until((s) =>
    s.rounds.some((r) => r.id === roundId && r.attempt.phase.kind === "finished"),
  );
  const round = snap.rounds.find((r) => r.id === roundId)!;
  assert.equal(round.attempt.phase.kind, "finished");
  const id = round.attempt.phase.captureId;
  const capture = snap.captures.find((c) => c.id === id);
  assert.ok(capture, "Finished round and capture must be installed together");
  assert.equal(capture.attemptId, round.attempt.attemptId);
  return { round, capture };
}
export async function diff(
  reader: Reader,
  s: PatchHost,
  threadId: ThreadId,
  id: CaptureId,
  to?: CaptureId,
) {
  const target = address(s, threadId);
  return accepted(
    await reader.read(
      to
        ? { kind: "roundRange", ...target, fromCaptureId: id, toCaptureId: to }
        : { kind: "round", ...target, captureId: id },
    ),
    "checkpointDiff",
  ).diff;
}
export function comparison(capture: CheckpointCapture) {
  const r = capture.result;
  assert.equal(r.kind, "ready");
  assert.ok(r.comparison);
  return r.comparison;
}
export function retainedCaptureBytes(repo: string, state: string) {
  const refs = git(repo, "for-each-ref", "--format=%(refname)", "refs/kraka/checkpoints")
    .split("\n")
    .filter(Boolean);
  const privateRefs = new Set(refs);
  const others = git(repo, "for-each-ref", "--format=%(refname)")
    .split("\n")
    .filter((r) => r && !privateRefs.has(r));
  const reachable = refs.length
    ? git(repo, "rev-list", "--objects", "--no-object-names", ...refs, "--not", "HEAD", ...others)
        .split("\n")
        .filter(Boolean)
    : [];
  let objectBytes = 0;
  if (reachable.length) {
    const sizes = Bun.spawnSync(
      ["git", "-C", repo, "cat-file", "--batch-check=%(objectsize:disk)"],
      { stdin: Buffer.from(reachable.join("\n") + "\n") },
    );
    assert.equal(sizes.exitCode, 0);
    const rows = sizes.stdout.toString().trim().split("\n");
    assert.equal(rows.length, reachable.length);
    for (const r of rows) {
      assert.match(r, /^\d+$/);
      objectBytes += Number(r);
    }
  }
  const gitDir = git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir");
  let refBytes = 0;
  for (const ref of refs) {
    const file = join(gitDir, ref);
    if (existsSync(file)) refBytes += statSync(file).size;
  }
  const packed = join(gitDir, "packed-refs");
  if (existsSync(packed))
    for (const line of readFileSync(packed, "utf8").split(/(?<=\n)/))
      if (privateRefs.has(line.trimEnd().split(" ")[1] ?? "")) refBytes += Buffer.byteLength(line);
  function size(path: string): number {
    return existsSync(path)
      ? readdirSync(path, { withFileTypes: true }).reduce(
          (sum, e) =>
            sum + (e.isDirectory() ? size(join(path, e.name)) : statSync(join(path, e.name)).size),
          0,
        )
      : 0;
  }
  return {
    refs: refs.length,
    objects: reachable.length,
    objectBytes,
    refBytes,
    scratchBytes: size(join(state, "capture-scratch")),
  };
}
export async function interruptedCapture(stage: "sealed" | "published", root = productRoot) {
  let reading:
    | { elapsedMs: number; retained: ReturnType<typeof retainedCaptureBytes>; id: string }
    | undefined;
  await patchCase(
    async (s, b) => {
      const repo = s.f.cwd;
      const head = git(repo, "rev-parse", "HEAD");
      writeFileSync(join(repo, "version.txt"), "user staged");
      git(repo, "add", "version.txt");
      const index = git(repo, "ls-files", "--stage");
      const first = await s.start("command");
      writeFileSync(join(repo, "version.txt"), "original boundary");
      b.hold = stage;
      s.action(first.turn.handle, "finish");
      const hit = await b.events.until((e) => e.stage === stage && e.boundary === "after");
      const db = openReceiptReader(s.state);
      let tree: string;
      try {
        const row = db
          .query<{ seal: string }, [string]>("SELECT seal FROM capture_intents WHERE id=?")
          .get(hit.id);
        assert.ok(row);
        tree = JSON.parse(row.seal).tree;
        if (stage === "published")
          assert.equal(git(repo, "show", tree + ":version.txt"), "original boundary");
      } finally {
        db.close(true);
      }
      writeFileSync(join(repo, "version.txt"), "newer edit after seal");
      const start = await s.restart(true);
      const reader = await s.patchReader(first.threadId);
      const { capture } = await finished(reader, first.roundId);
      const pair = comparison(capture);
      assert.equal(capture.id, hit.id);
      assert.equal(git(repo, "rev-parse", pair.after + "^{tree}"), tree);
      assert.equal(git(repo, "show", pair.before + ":version.txt"), "user staged");
      assert.equal(git(repo, "show", pair.after + ":version.txt"), "original boundary");
      const reopened = openReceiptReader(s.state);
      try {
        assert.deepEqual(
          reopened
            .query(
              "SELECT count(*) AS n FROM sync_rows WHERE source=? AND key=? AND version='1' AND created=changed",
            )
            .get(first.threadId, JSON.stringify(["checkpointCapture", capture.id])),
          { n: 1 },
        );
      } finally {
        reopened.close(true);
      }
      const elapsedMs = performance.now() - start;
      assert.equal(git(repo, "rev-parse", "HEAD"), head);
      assert.equal(git(repo, "ls-files", "--stage"), index);
      assert.equal(readFileSync(join(repo, "version.txt"), "utf8"), "newer edit after seal");
      const retained = retainedCaptureBytes(repo, s.state);
      assert.equal(retained.refs, 2);
      assert.ok(retained.objectBytes > 0);
      assert.equal(retained.scratchBytes, 0);
      reading = { elapsedMs, retained, id: capture.id };
    },
    true,
    root,
  );
  assert.ok(reading);
  return reading;
}
