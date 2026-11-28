// Live cases 7; required groups ["1.", "2.", "3.", "4."]
import { cumulativeRoundRange } from "../../packages/client-runtime/src";
import { test, expect } from "bun:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { mkdirSync, readdirSync, writeFileSync, readFileSync, symlinkSync } from "node:fs";
import { accepted } from "../fixtures/first-send";
import { within } from "../fixtures/replay-process";
import { git, seedGit } from "../fixtures/isolated-start";
import { finishedCapture } from "../fixtures/first-send-client";
import {
  address,
  comparison,
  diff,
  finished,
  interruptedCapture,
  patchCase,
} from "../fixtures/round-patch";

test(
  "1. two clients see the native end before the matching checkpoint settles",
  () =>
    patchCase(async (s, b) => {
      const startup = s.f
        .stderrTail()
        .split("\n")
        .find((line) => line.startsWith("Writer startup timing "));
      if (startup) console.error(startup);
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
      const sawClosing = Promise.withResolvers<void>();
      const installed = s.client.subscribedRounds(t.threadId, (rounds) => {
        const phase = rounds.find((r) => r.id === t.roundId && r.attempt.attemptId === t.attemptId)
          ?.attempt.phase;
        if (phase?.kind === "closing") sawClosing.resolve();
        return phase?.kind === "finished";
      });
      await within(sawClosing.promise, 5000, "Local subscriber observed the closing capture");
      b.release(hit.token);
      b.hold = null;
      expect((await installed).find((r) => r.id === t.roundId)?.attempt.phase).toMatchObject({
        kind: "finished",
        captureId: hit.id,
      });
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
          /^(?:refs\/kraka\/checkpoints\/w-[0-9a-f]{64}\/[0-9a-f]{64}\/[0-9a-f]{64}\/(?:before|after)|objects\/[0-9a-f]{2}\/[0-9a-f]+)$/,
        );
      expect((await finished(legacy, t.roundId)).capture.result).toEqual({
        kind: "missing",
        reason: "directoryDiffUnsupported",
      });
      expect(
        await legacy.read({ kind: "round", ...address(s, t.threadId), captureId: capture.id }),
      ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
    }),
  45000,
);
test("2. a missing checkpoint preserves success and a verified empty patch stays empty", async () => {
  for (const repository of [false, true])
    await patchCase(async (s) => {
      if (repository) {
        git(s.f.cwd, "config", "core.autocrlf", "true");
        writeFileSync(join(s.f.cwd, "version.txt"), "unchanged worktree bytes\r\n");
        git(s.f.cwd, "add", "version.txt");
        git(s.f.cwd, "commit", "-qm", "Record normalized Git content");
      }
      const t = await s.start("command"),
        client = await s.patchReader(t.threadId);
      s.action(t.turn.handle, "finish");
      const { capture, round } = await finished(client, t.roundId);
      expect(round.attempt.phase.kind).toBe("finished");
      expect(capture.result.kind).toBe(repository ? "ready" : "missing");
      expect((await diff(client, s, t.threadId, capture.id)).kind).toBe(
        repository ? "empty" : "unavailable",
      );
      if (repository) {
        const pair = comparison(capture);
        expect(pair.summary).toEqual({ kind: "empty" });
        expect(git(s.f.cwd, "rev-parse", pair.before + ":version.txt")).toBe(
          git(s.f.cwd, "rev-parse", "HEAD:version.txt"),
        );
      }
    }, repository);
}, 45000);
test(
  "a failed private-index add identifies the failing Git step and preserves native success",
  () =>
    patchCase(async (s) => {
      const repo = s.f.cwd;
      git(
        repo,
        "config",
        "filter.capture-failure.clean",
        "git rev-parse --verify refs/capture-test-absent",
      );
      git(repo, "config", "filter.capture-failure.required", "true");
      writeFileSync(join(repo, ".gitattributes"), "unreadable filter=capture-failure\n");
      writeFileSync(join(repo, "unreadable"), "fixture");
      const t = await s.start("command"),
        reader = await s.patchReader(t.threadId);
      s.action(t.turn.handle, "finish");
      const { capture, round } = await finished(reader, t.roundId);
      expect(round.attempt.phase.kind).toBe("finished");
      expect(capture.result).toEqual({ kind: "error", boundary: "before", reason: "index.add" });
      await s.f.stop();
      expect(s.stderrTails().join(" ")).toContain("Git exit");
      expect(s.stderrTails().join(" ")).toContain("index.add");
    }),
  45000,
);

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
}, 45000);
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

for (const boundary of ["before", "after"] as const) {
  test(
    `restart admits another directory while the ${boundary} checkpoint recovers`,
    () =>
      patchCase(async (s, b) => {
        const independent = seedGit(dirname(s.f.cwd), "independent");
        const project = accepted(
          (await s.client.send("project.register", { realPath: independent.path })).receipt,
          "projectRegistered",
        ).project;
        const send = async (text: string, projectId = s.f.project.id) =>
          accepted(
            (
              await s.client.send("thread.start", {
                ...s.f.payload,
                projectId,
                instanceId: s.f.registration.instanceId,
                content: { ...s.f.payload.content, text },
              })
            ).receipt,
            "threadStarted",
          );
        b.holdBoundary = boundary;
        b.hold = "sealed";
        const original = await send("original");
        if (boundary === "after") {
          const turn = await s.events.untilDispatch(
            (e) => e.event === "turn" && e.text === "original",
          );
          s.action(turn.handle, "finish");
        }
        const sealed = await b.events.until(
          (e) => e.round === original.roundId && e.stage === "sealed" && e.boundary === boundary,
        );
        b.holdId = sealed.id;
        b.hold = "published";
        const since = b.events.items.length;
        await s.restart(true, b);
        const held = await b.events.until(
          (e) => e.id === sealed.id && e.stage === "published",
          since,
        );
        const timing = s
          .stderrTails()
          .at(-1)
          ?.split("\n")
          .find((l) => l.startsWith("Writer startup timing "));
        assert.ok(timing);
        expect(JSON.parse(timing.slice("Writer startup timing ".length)).gitProcesses).toBe(0);
        if (boundary === "after")
          expect(
            (await s.client.readInputHistory(original.threadId)).rounds[0]?.attempt.phase,
          ).toMatchObject({ kind: "closing", captureId: sealed.id });
        const same = await send("same");
        const other = await send("independent", project.id);
        const native = await s.events.untilDispatch(
          (e) => e.event === "turn" && e.text === "independent",
        );
        s.action(native.handle, "finish");
        await finishedCapture(s.client, other);
        expect(b.events.items.some((e) => e.round === same.roundId)).toBe(false);
        b.hold = null;
        b.release(held.token);
        const next = await s.events.untilDispatch((e) => e.event === "turn" && e.text === "same");
        s.action(next.handle, "finish");
        await finishedCapture(s.client, same);
        const settled = b.events.items.findIndex(
          (e) => e.id === sealed.id && e.boundary === boundary && e.stage === "settled",
        );
        expect(settled).toBeGreaterThanOrEqual(since);
        expect(b.events.items.findIndex((e) => e.round === same.roundId)).toBeGreaterThan(settled);
      }),
    60000,
  );
}
