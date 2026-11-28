import { cumulativeRoundRange } from "../packages/client-runtime/src";
import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, readdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { accepted } from "./fixtures/first-send";
import { git } from "./fixtures/isolated-start";
import {
  address,
  comparison,
  diff,
  finished,
  interruptedCapture,
  patchCase,
} from "./fixtures/round-patch";

test(
  "1. two clients see the native end before the matching checkpoint settles",
  () =>
    patchCase(async (s, b) => {
      console.log(git(s.f.cwd, "--version"));
      const common = git(s.f.cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
      function files(dir: string, prefix = ""): string[] {
        return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? files(join(dir, e.name), prefix + e.name + "/") : [prefix + e.name],
        );
      }
      const hooks = join(s.state, "reject-ref-hooks");
      mkdirSync(hooks);
      writeFileSync(join(hooks, "reference-transaction"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
      git(s.f.cwd, "config", "core.hooksPath", hooks);
      const repo = s.f.cwd;
      writeFileSync(join(repo, "tracked.log"), "staged");
      git(repo, "add", "tracked.log");
      writeFileSync(join(common, "info", "exclude"), "*.log\n");
      writeFileSync(join(repo, "tracked.log"), "working");
      writeFileSync(join(repo, "ignored.log"), "ignored");
      if (process.platform !== "win32") {
        writeFileSync(join(repo, "executable"), "run", { mode: 0o755 });
        symlinkSync("tracked.log", join(repo, "link"));
      }
      const index = readFileSync(join(common, "index")),
        original = new Set(files(common));
      const t = await s.start("command");
      const a = await s.patchReader(t.threadId),
        other = await s.patchReader(t.threadId),
        legacy = await s.patchReader(t.threadId, false);
      writeFileSync(join(s.f.cwd, "version.txt"), "changed by hand");
      b.hold = "published";
      s.action(t.turn.handle, "finish");
      const ended = await s.updates.until(
        (e) => e.kind === "round.ended" && e.attemptId === t.attemptId,
      );
      assert.ok(ended.kind === "round.ended");
      expect(ended.outcome).toBe("completed");
      const hit = await b.events.until((e) => e.stage === "published" && e.boundary === "after");
      for (const client of [a, other]) {
        const snap = await client.snapshots.until((s) =>
          s.rounds.some((r) => r.id === t.roundId && r.attempt.phase.kind === "closing"),
        );
        expect(snap.captures).toHaveLength(0);
        expect(snap.rounds.find((r) => r.id === t.roundId)?.attempt.phase).toMatchObject({
          captureId: hit.id,
          endedAt: ended.endedAt,
        });
      }
      b.release(hit.token);
      b.hold = null;
      const { round, capture } = await finished(a, t.roundId);
      expect((await finished(other, t.roundId)).capture).toEqual(capture);
      expect(round.attempt.phase).toMatchObject({
        endedAt: ended.endedAt,
        endTimeEvidence: ended.endTimeEvidence,
      });
      assert.equal(capture.version, "1");
      const patch = await diff(a, s, t.threadId, capture.id);
      expect(patch).toMatchObject({
        kind: "changed",
        from: { commit: comparison(capture).before },
        to: { commit: comparison(capture).after },
      });
      assert.equal(patch.kind, "changed");
      expect(patch.patch).toContain("+changed by hand");
      for (const commit of [comparison(capture).before, comparison(capture).after]) {
        expect(git(repo, "show", commit + ":tracked.log")).toBe("working");
        expect(git(repo, "ls-tree", commit, "ignored.log")).toBe("");
        if (process.platform !== "win32") {
          expect(git(repo, "ls-tree", commit, "executable")).toMatch(/^100755 /);
          expect(git(repo, "ls-tree", commit, "link")).toMatch(/^120000 /);
        }
      }
      expect(readFileSync(join(common, "index"))).toEqual(index);
      const added = files(common).filter((f) => !original.has(f));
      expect(added.filter((f) => f.startsWith("refs/kraka/checkpoints/"))).toHaveLength(2);
      for (const file of added)
        expect(file).toMatch(
          /^(?:refs\/kraka\/checkpoints\/[0-9a-f/]+\/(?:before|after)|objects\/[0-9a-f]{2}\/[0-9a-f]+)$/,
        );
      expect((await finished(legacy, t.roundId)).capture.result).toEqual({
        kind: "missing",
        reason: "directoryDiffUnsupported",
      });
      expect(
        await legacy.read({ kind: "round", ...address(s, t.threadId), captureId: capture.id }),
      ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
    }),
  20000,
);
test("2. a missing checkpoint preserves success and a verified empty patch stays empty", async () => {
  for (const repository of [false, true])
    await patchCase(async (s) => {
      const t = await s.start("command"),
        client = await s.patchReader(t.threadId);
      s.action(t.turn.handle, "finish");
      const { capture, round } = await finished(client, t.roundId);
      expect(round.attempt.phase.kind).toBe("finished");
      expect(capture.result.kind).toBe(repository ? "ready" : "missing");
      expect((await diff(client, s, t.threadId, capture.id)).kind).toBe(
        repository ? "empty" : "unavailable",
      );
      if (repository) expect(comparison(capture).summary).toEqual({ kind: "empty" });
    }, repository);
}, 30000);
test("3. shared manual edits have unknown authors and a failed summary still has a patch", async () => {
  await patchCase(async (s) => {
    const a = await s.start("command"),
      b = await s.start("command");
    const first = await s.patchReader(a.threadId),
      second = await s.patchReader(b.threadId);
    writeFileSync(join(s.f.cwd, "version.txt"), "manual shared edit");
    s.action(a.turn.handle, "finish");
    s.action(b.turn.handle, "finish");
    for (const [turn, reader] of [
      [a, first],
      [b, second],
    ] as const) {
      const { capture } = await finished(reader, turn.roundId),
        patch = await diff(reader, s, turn.threadId, capture.id);
      expect(patch).toMatchObject({
        kind: "changed",
        files: [{ path: "version.txt", owner: { kind: "unknown", reason: "sharedWriter" } }],
      });
    }
  });
  await patchCase(async (s, b) => {
    const t = await s.start("command"),
      reader = await s.patchReader(t.threadId);
    b.failSummary = true;
    writeFileSync(join(s.f.cwd, "version.txt"), "summary failure");
    s.action(t.turn.handle, "finish");
    const { capture } = await finished(reader, t.roundId),
      pair = comparison(capture);
    expect(pair.summary.kind).toBe("unknown");
    const patch = await diff(reader, s, t.threadId, capture.id);
    assert.equal(patch.kind, "changed");
    expect(patch.patch).toContain("+summary failure");
    expect(patch).toMatchObject({ from: { commit: pair.before }, to: { commit: pair.after } });
  });
}, 30000);
test("4. a staged edit enters the next baseline and both crash windows settle once", async () => {
  await patchCase(async (s) => {
    const t = await s.start("command"),
      r = await s.patchReader(t.threadId),
      repo = s.f.cwd;
    writeFileSync(join(repo, "one"), "first turn");
    s.action(t.turn.handle, "finish");
    const first = (await finished(r, t.roundId)).capture;
    writeFileSync(join(repo, "human"), "between turns");
    git(repo, "add", "human");
    const since = s.events.items.length,
      secondId = accepted((await s.input(t.threadId, "resume")).receipt, "inputScheduled");
    const secondTurn = await s.event("turn", since);
    writeFileSync(join(repo, "two"), "second turn");
    s.action(secondTurn.handle, "finish");
    const second = (await finished(r, secondId.roundId)).capture;
    expect(git(repo, "show", comparison(second).before + ":human")).toBe("between turns");
    for (const [c, name] of [
      [first, "one"],
      [second, "two"],
    ] as const) {
      const p = await diff(r, s, t.threadId, c.id);
      assert.equal(p.kind, "changed");
      expect(p.files.map((f) => f.path)).toEqual([name]);
      expect(p).toMatchObject({
        from: { commit: comparison(c).before },
        to: { commit: comparison(c).after },
      });
    }
    const history = r.snapshots.items.at(-1);
    assert.ok(history);
    const cumulative = cumulativeRoundRange(
      { kind: "round", ...address(s, t.threadId), captureId: second.id },
      history.rounds,
      history.captures,
    );
    assert.ok(cumulative);
    expect(cumulative).toMatchObject({ fromCaptureId: first.id, toCaptureId: second.id });
    const range = accepted(await r.read(cumulative), "checkpointDiff").diff;
    assert.equal(range.kind, "changed");
    expect(range.files.map((f) => f.path)).toEqual(["human", "one", "two"]);
    expect(range).toMatchObject({
      from: { commit: comparison(first).before },
      to: { commit: comparison(second).after },
    });
    expect((await diff(r, s, t.threadId, second.id, first.id)).kind).toBe("unavailable");
  });
  for (const stage of ["sealed", "published"] as const) await interruptedCapture(stage);
}, 45000);
