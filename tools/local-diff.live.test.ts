import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright";
import { launchBrowser } from "./fixtures/browser-selection";
import * as v from "valibot";
import {
  DeviceIdSchema,
  DeviceKeyIdSchema,
  P256PublicKeySchema,
  GitObjectIdSchema,
  type DiffRequest,
  type DiffResult,
  type GitStatus,
  type CommandReceipt,
} from "@kraka/protocol";
import type { GitStatusUpdate } from "../packages/client-runtime/src";
import { signP256 } from "@kraka/protocol/web-crypto";
import { connectGitClient } from "../packages/cli-client/src/git-client";
import { openAccessHost } from "../packages/daemon/src/access";
import { openReceiptReader } from "@kraka/environment";
import { accepted, startFirstSendFixture, launchWriter, productRoot } from "./fixtures/first-send";
import { cli, git, readClaim, seedGit } from "./fixtures/isolated-start";
import { cliObserver } from "./fixtures/local-diff-cli";
import { Journal } from "./fixtures/route-network";
import { withState } from "./fixtures/replay-process";
import type { FixtureCredentials } from "./fixtures/local-diff-browser";

type BrowserAPI = typeof globalThis & {
  S15Client: {
    connect(input: FixtureCredentials): ReturnType<typeof connectGitClient>;
    branch(id: string, name: string): Promise<GitStatusUpdate>;
  };
};
async function browserConnection(page: Page, credentials: FixtureCredentials) {
  const url = new URL("/s15", credentials.url);
  url.protocol = "http:";
  await page.goto(url.href);
  const client = await page.evaluateHandle(
    (c) => (globalThis as BrowserAPI).S15Client.connect(c),
    credentials,
  );
  return {
    request: (method: string, payload: unknown) =>
      client.evaluate((c, r) => c.request(r.method, r.payload), { method, payload }),
    diff: (query: DiffRequest, cursor: string | null = null) =>
      client.evaluate((c, r) => c.diff(r.query, r.cursor), { query, cursor }),
    branch: (id: string, name: string) =>
      page.evaluate((r) => (globalThis as BrowserAPI).S15Client.branch(r.id, r.name), { id, name }),
  };
}
type Ended = { event: "completed"; roundId: string; threadId: string };
const endedSchema = v.object({
  event: v.literal("completed"),
  roundId: v.string(),
  threadId: v.string(),
});
async function withCheckout(
  run: (
    f: Awaited<ReturnType<typeof prepare>>,
    browser: Awaited<ReturnType<typeof browserConnection>>,
  ) => Promise<void>,
) {
  await withState(async (dir) => {
    const f = await prepare(dir);
    try {
      const driver = await launchBrowser();
      try {
        const context = await driver.newContext();
        try {
          await run(f, await browserConnection(await context.newPage(), f.credentials));
        } finally {
          await context.close();
        }
      } finally {
        await driver.close();
      }
    } finally {
      await f.daemon.close();
    }
  });
}
async function prepare(dir: string, repo = seedGit(dir)) {
  const common = git(repo.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
  const metadataBefore = gitMetadataFiles(common);
  git(repo.path, "config", "core.autocrlf", "false");
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const build = await Bun.build({
    entrypoints: [join(productRoot, "tools/fixtures/local-diff-browser.ts")],
    format: "iife",
    target: "browser",
    outdir: state,
    naming: "s15-client.js",
  });
  if (!build.success) throw Error(build.logs.join("\n"));
  const completed = new Journal<Ended>();
  const probes = new Journal<{ directory: string; granularity: string }>();
  const daemon = await startFirstSendFixture({
    stateDir: state,
    projectDirectory: repo.path,
    adapter: "replay",
    point: "local-diff",
    ipc(msg) {
      const probe = v.safeParse(
        v.object({
          event: v.literal("gitProcess"),
          directory: v.string(),
          granularity: v.string(),
        }),
        msg,
      );
      if (probe.success) probes.push(probe.output);
      const row = v.safeParse(endedSchema, msg);
      if (row.success) completed.push(row.output);
    },
  });
  try {
    const access = await openAccessHost(state, {
      present: async () => true,
      approve: async () => true,
    });
    const credentials = await (async () => {
      try {
        const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
        const key = v.parse(
          v.object({
            kty: v.literal("EC"),
            crv: v.literal("P-256"),
            x: v.string(),
            y: v.string(),
            d: v.string(),
          }),
          keys.privateKey.export({ format: "jwk" }),
        );
        const deviceId = v.parse(DeviceIdSchema, "git-test-device"),
          keyId = v.parse(DeviceKeyIdSchema, "git-test-key");
        const point = Buffer.concat([
          Buffer.from([4]),
          Buffer.from(key.x, "base64url"),
          Buffer.from(key.y, "base64url"),
        ]);
        await access.trusted.confirm({
          kind: "bootstrap",
          environment: access.identity,
          deviceId,
          keyId,
          publicKey: v.parse(P256PublicKeySchema, point.toString("base64url")),
        });
        const device = access.store.device(deviceId);
        if (!device) throw Error("Fixture device registration failed");
        return {
          identity: access.identity,
          principal: device.principal,
          signer: { kind: "device" as const, deviceId, keyId },
          url: daemon.instance.endpoint,
          privateKey: key,
        } satisfies FixtureCredentials;
      } finally {
        access.close();
      }
    })();
    const root = daemon.project.root;
    if (!root) throw Error("Missing checkout binding");
    const thread = async (project = daemon.project) => {
      const { receipt } = await daemon.client.send("thread.start", {
        ...daemon.payload,
        projectId: project.id,
      });
      const turn = accepted(receipt, "threadStarted");
      await completed.until((e) => e.roundId === turn.roundId && e.threadId === turn.threadId);
      if (!project.root) throw Error("Missing registered checkout");
      return {
        threadId: turn.threadId,
        directoryId: project.root.directoryId,
        generation: project.root.generation,
      };
    };
    return {
      dir,
      state,
      repo,
      root,
      credentials,
      daemon,
      thread,
      completed,
      probes,
      common,
      metadataBefore,
    };
  } catch (e) {
    await daemon.close();
    throw e;
  }
}
function changed(diff: DiffResult) {
  if (diff.kind !== "changed") throw Error(JSON.stringify(diff));
  return diff;
}
function status(receipt: CommandReceipt) {
  return accepted(receipt, "gitStatus").snapshot;
}
function names(diff: DiffResult) {
  return changed(diff)
    .files.map((file) => file.path)
    .sort();
}
const oid = (path: string, ref: string) => v.parse(GitObjectIdSchema, git(path, "rev-parse", ref));

test(
  "1. J-2.6 two completed turns share branch observations across a browser and CLI",
  () =>
    withCheckout(async (f, b) => {
      const a = await f.thread(),
        other = await f.thread();
      expect(f.root.realPath).toBe(realpathSync.native(f.repo.path));
      const at = { kind: "thread" as const, ...a },
        bt = { kind: "thread" as const, ...other };
      const cliClient = await cliObserver(f.credentials);
      try {
        const open = { granularity: "detailed", streamId: 1, subscriptionId: "git" };
        for (const receipt of [
          await b.request("git.subscribeStatus", { ...open, target: at }),
          await cliClient.request("git.subscribeStatus", { ...open, target: bt }),
        ])
          expect(accepted(receipt, "subscriptionOpened").streamId).toBe(1);
        async function installed(branch: string) {
          const [web, terminal] = await Promise.all([
            b.branch("git", branch),
            cliClient.installed(
              (s) => s.kind === "detailed" && s.head.kind === "branch" && s.head.name === branch,
            ),
          ]);
          for (const [update, target] of [
            [web, at],
            [terminal, bt],
          ] as const)
            expect(update.snapshot).toMatchObject({
              target,
              kind: "detailed",
              head: {
                name: git(f.repo.path, "branch", "--show-current"),
                tip: oid(f.repo.path, "HEAD"),
              },
            });
          return web.snapshot.sequence;
        }
        const initial = await installed("main");
        expect(await f.probes.until((p) => p.granularity === "detailed")).toMatchObject({
          directory: realpathSync.native(f.repo.path),
        });
        const stale = await b.request("git.readStatus", {
          granularity: "detailed",
          target: { ...at, generation: "0" },
        });
        expect(status(stale)).toMatchObject({ kind: "invalidated", target: { generation: "0" } });
        accepted(
          await cliClient.request("git.subscribeStatus", {
            subscriptionId: "stale",
            streamId: 2,
            target: { ...bt, generation: "0" },
            granularity: "branch",
          }),
          "subscriptionOpened",
        );
        expect((await cliClient.installed((_, id) => id === "stale")).snapshot).toMatchObject({
          kind: "invalidated",
          target: { generation: "0" },
        });
        writeFileSync(join(f.repo.path, "shared.txt"), "shared\n");
        git(f.repo.path, "switch", "-c", "feature");
        expect(await installed("feature")).toBeGreaterThan(initial);
        for (const s of [
          status(await b.request("git.readStatus", { granularity: "detailed", target: at })),
          status(
            await cliClient.request("git.readStatus", { granularity: "detailed", target: bt }),
          ),
        ])
          expect(s).toMatchObject({
            kind: "detailed",
            head: { name: "feature" },
            untracked: ["shared.txt"],
          });
        expect(changed(await b.diff({ kind: "workingTree", ...a })).files[0]?.owner).toEqual({
          kind: "unknown",
          reason: "sharedWriter",
        });
      } finally {
        await cliClient.close();
      }
    }),
  60000,
);

test(
  "2. branch comparison begins at the fork and working-tree comparison begins at HEAD",
  () =>
    withCheckout(async (f, b) => {
      const a = await f.thread(),
        cwd = f.repo.path;
      git(cwd, "branch", "task", f.repo.base);
      writeFileSync(join(cwd, "b"), "main only");
      git(cwd, "add", "b");
      git(cwd, "commit", "-qm", "main only");
      git(cwd, "switch", "task");
      writeFileSync(join(cwd, "task"), "task commit");
      git(cwd, "add", "task");
      git(cwd, "commit", "-qm", "task only");
      writeFileSync(join(cwd, "pending"), "pending change");
      const diff = await b.diff({ kind: "branch", ...a, baseRef: "main" });
      expect(names(diff)).toEqual(["pending", "task"]);
      expect(changed(diff).from).toMatchObject({
        relation: "mergeBase",
        oid: git(cwd, "merge-base", "HEAD", "main"),
      });
      const pending = await b.diff({ kind: "workingTree", ...a });
      expect(names(pending)).toEqual(["pending"]);
      expect(changed(pending).from).toMatchObject({ relation: "head", oid: oid(cwd, "HEAD") });
    }),
  60000,
);

test(
  "3. two managed worktrees stay isolated and a merge uses its first parent",
  () =>
    withCheckout(async (f, b) => {
      async function checkout(branch: string) {
        const r = await cli(f.daemon, branch, {
          kind: "isolated",
          selection: { baseRef: f.repo.base, branch },
        });
        await f.completed.until((e) => e.roundId === r.ids.roundId);
        const wid = r.request.payload.worktreeId;
        if (!wid) throw Error("Missing worktree ID");
        const managed = readClaim(f.state, wid);
        expect(managed.claim.phase.kind).toBe("ready");
        expect(oid(managed.directory.realPath, "HEAD")).toBe(
          v.parse(GitObjectIdSchema, f.repo.base),
        );
        return {
          cwd: managed.directory.realPath,
          query: { threadId: r.ids.threadId, worktreeId: wid },
        };
      }
      const a = await checkout("task-a"),
        other = await checkout("task-b");
      writeFileSync(join(a.cwd, "marker"), "only in A");
      expect(names(await b.diff({ kind: "workingTree", ...a.query }))).toEqual(["marker"]);
      expect((await b.diff({ kind: "workingTree", ...other.query })).kind).toBe("empty");
      const legacy = await fixtureGitClient(f.credentials, f.credentials.url, false);
      try {
        const shared = await f.thread();
        expect(
          await legacy.request("checkpoint.diff", {
            query: { kind: "workingTree", ...shared },
            cursor: null,
          }),
        ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
        expect(names(await legacy.diff({ kind: "workingTree", ...a.query }))).toEqual(["marker"]);
      } finally {
        legacy.close();
      }
      const path = "version.txt";
      for (const [w, bytes] of [
        [a, "first parent"],
        [other, "second parent"],
      ] as const) {
        writeFileSync(join(w.cwd, path), bytes);
        git(w.cwd, "commit", "-qam", bytes);
      }
      const conflict = Bun.spawnSync([
        "git",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-C",
        a.cwd,
        "merge",
        "--no-commit",
        "task-b",
      ]);
      expect(conflict.exitCode).toBe(1);
      writeFileSync(join(a.cwd, path), "merge value");
      git(a.cwd, "add", path);
      git(
        a.cwd,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "commit",
        "-qm",
        "merge",
      );
      const commit = oid(a.cwd, "HEAD");
      expect(git(a.cwd, "rev-list", "--parents", "-1", commit).split(" ")).toHaveLength(3);
      const query = { kind: "commit" as const, ...a.query, commit },
        diff = changed(await b.diff(query));
      expect(diff.from).toMatchObject({ relation: "firstParent", oid: oid(a.cwd, `${commit}^1`) });
      expect(diff.to).toMatchObject({ relation: "commit", oid: commit });
      const left = oid(a.cwd, `${commit}^1:${path}`),
        right = oid(a.cwd, `${commit}:${path}`);
      expect(diff.patch).toContain(`index ${left}..${right}`);
      expect(diff.patch).toContain(`-${git(a.cwd, "cat-file", "blob", left)}`);
      expect(diff.patch).toContain(`+${git(a.cwd, "cat-file", "blob", right)}`);
      writeFileSync(join(a.cwd, path), "after comparison");
      expect(await b.diff(query)).toEqual(diff);
    }),
  60000,
);

test(
  "4. file sides, empty/non-repository status and complete UTF-8 pages stay pinned",
  () =>
    withCheckout(async (f, b) => {
      const a = await f.thread(),
        cwd = f.repo.path;
      const query = { kind: "workingTree" as const, ...a };
      expect((await b.diff(query)).kind).toBe("empty");
      const empty = join(f.dir, "empty");
      mkdirSync(empty);
      const project = accepted(
        (await f.daemon.client.send("project.register", { realPath: empty })).receipt,
        "projectRegistered",
      ).project;
      if (!project.root) throw Error("Missing non-repository root");
      expect(
        status(
          await b.request("git.readStatus", {
            granularity: "detailed",
            target: {
              kind: "project",
              projectId: project.id,
              directoryId: project.root.directoryId,
              generation: project.root.generation,
            },
          }),
        ),
      ).toMatchObject({ kind: "notRepository" });
      writeFileSync(join(cwd, "removed"), "removed\n");
      git(cwd, "add", "removed");
      git(cwd, "commit", "-qm", "old files");
      rmSync(join(cwd, "removed"));
      writeFileSync(join(cwd, "version.txt"), "edited\n");
      writeFileSync(join(cwd, "added"), "added\n");
      const files = changed(await b.diff(query));
      expect(files.files.map((x) => [x.path, x.change])).toEqual([
        ["added", "added"],
        ["removed", "removed"],
        ["version.txt", "modified"],
      ]);
      if (files.from.kind !== "git" || files.to.kind !== "workingTree")
        throw Error("Missing fixed endpoints");
      for (const [path, old, next] of [
        ["added", null, "added"],
        ["removed", "removed", null],
        ["version.txt", "first", "edited"],
      ] as const) {
        for (const [object, content] of [
          [files.from.oid, old],
          [files.to.tree, next],
        ] as const) {
          const probe = Bun.spawnSync(["git", "-C", cwd, "show", `${object}:${path}`]);
          if (content === null) expect(probe.exitCode).not.toBe(0);
          else {
            expect(probe.exitCode).toBe(0);
            expect(probe.stdout.toString().trimEnd()).toBe(content);
          }
        }
      }
      git(cwd, "add", "-A");
      git(cwd, "commit", "-qm", "new baseline");
      const text = `${"好😀".repeat(1450000)}\n`;
      writeFileSync(join(cwd, "large.txt"), text);
      const first = changed(await b.diff(query));
      expect(first.truncated).toBe(true);
      if (!first.next || first.to.kind !== "workingTree" || first.from.kind !== "git")
        throw Error("Missing continuation");
      const expected = Bun.spawnSync(
        [
          "git",
          "-C",
          cwd,
          "diff",
          "--full-index",
          first.from.oid,
          first.to.tree,
          "--",
          "large.txt",
        ],
        { maxBuffer: 20_000_000 },
      );
      expect(expected.exitCode).toBe(0);
      writeFileSync(join(cwd, "large.txt"), "later\n");
      const last = changed(await b.diff(query, first.next));
      expect(last.from).toEqual(first.from);
      expect(last.to).toEqual(first.to);
      expect(last.next).toBeNull();
      expect(Buffer.byteLength(first.patch)).toBeLessThanOrEqual(10_000_000);
      expect(Buffer.from(first.patch + last.patch).equals(expected.stdout)).toBe(true);
    }),
  120000,
);

async function fixtureGitClient(
  credentials: FixtureCredentials,
  endpoint: string,
  directoryDiff = true,
) {
  const key = await crypto.subtle.importKey(
    "jwk",
    credentials.privateKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  return connectGitClient(
    endpoint,
    { ...credentials, sign: (s) => signP256(key, s) },
    () => {},
    directoryDiff,
  );
}

function cleanupIntents(state: string) {
  const db = openReceiptReader(state);
  try {
    return db
      .query<{ id: string; scratch: string }, []>("SELECT id,scratch FROM diff_cleanup")
      .all();
  } finally {
    db.close(true);
  }
}
function pinnedComparison(f: Awaited<ReturnType<typeof prepare>>, tree: string) {
  const rows = cleanupIntents(f.state);
  expect(rows).toHaveLength(1);
  const intent = rows[0];
  if (!intent) throw Error("Missing cleanup intent");
  expect(existsSync(join(intent.scratch, "patch"))).toBe(true);
  const refs = git(f.repo.path, "for-each-ref", "--format=%(refname)", "refs/kraka/diffs/").split(
    /\r?\n/,
  );
  const name = refs.find((r) => r.endsWith("/" + intent.id + "/from"));
  if (!name) throw Error("Missing comparison ref");
  const writer = name.slice(0, -(intent.id.length + "/from".length));
  expect(writer).toMatch(/^refs\/kraka\/diffs\/w-[a-f0-9]{64}\/$/);
  const pair = writer + intent.id;
  expect(git(f.repo.path, "rev-parse", pair + "/from", pair + "/to").split(/\r?\n/)).toEqual([
    f.repo.base,
    tree,
  ]);
  return { writer, pair, scratch: intent.scratch };
}
function gitMetadataFiles(common: string, relative = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(common, relative), { withFileTypes: true })) {
    const name = relative ? relative + "/" + entry.name : entry.name;
    if (name === "refs" || name === "logs/refs") continue;
    if (entry.isDirectory()) files.push(...gitMetadataFiles(common, name));
    else if (!/^objects\/[a-f0-9]{2}\/(?:[a-f0-9]{38}|[a-f0-9]{62})$/.test(name)) files.push(name);
  }
  return files.sort();
}

function expectedPatch(cwd: string, from: string, to: string) {
  const r = Bun.spawnSync(["git", "-C", cwd, "diff", "--full-index", from, to, "--", "large.txt"], {
    maxBuffer: 15_000_000,
  });
  if (r.exitCode !== 0) throw Error(r.stderr.toString());
  return r.stdout;
}
test(
  "5. a killed writer releases only its own pins while the other writer finishes its comparison",
  () =>
    withCheckout(async (f, b) => {
      const cwd = f.repo.path,
        common = f.common;
      const checkpoint = "refs/kraka/checkpoints/other-thread/capture/after";
      const legacy = "refs/kraka/diffs/" + crypto.randomUUID();
      git(cwd, "update-ref", checkpoint, f.repo.base);
      git(cwd, "update-ref", legacy + "/from", f.repo.base);
      git(cwd, "update-ref", legacy + "/to", f.repo.base);
      const query = { kind: "workingTree" as const, ...(await f.thread()) };
      const other = await prepare(join(f.dir, "second-writer"), f.repo);
      try {
        const otherQuery = { kind: "workingTree" as const, ...(await other.thread()) };
        const otherClient = await fixtureGitClient(other.credentials, other.credentials.url);
        try {
          const userHooks = join(f.dir, "user-hooks");
          mkdirSync(userHooks);
          const hook = join(userHooks, "reference-transaction");
          writeFileSync(hook, '#!/bin/sh\necho called >> "$0.called"\nexit 1\n', { mode: 0o700 });
          git(cwd, "config", "core.hooksPath", userHooks);
          const hookProbe = Bun.spawnSync([
            "git",
            "-C",
            cwd,
            "update-ref",
            "refs/fixture/hook-probe",
            f.repo.base,
          ]);
          expect(hookProbe.exitCode).not.toBe(0);
          expect(existsSync(hook + ".called")).toBe(true);
          rmSync(hook + ".called");
          const file = join(cwd, "large.txt");
          const content = "A".repeat(10_050_000) + "\n";
          writeFileSync(file, content);
          const first = changed(await b.diff(query));
          if (!first.next || first.to.kind !== "workingTree")
            throw Error("Expected first writer's continuation");
          const own = pinnedComparison(f, first.to.tree);

          writeFileSync(file, "B".repeat(10_050_000) + "\n");
          const neighbor = changed(await otherClient.diff(otherQuery));
          if (!neighbor.next || neighbor.to.kind !== "workingTree")
            throw Error("Expected second writer's continuation");
          const foreign = pinnedComparison(other, neighbor.to.tree);
          expect(foreign.writer).not.toBe(own.writer);
          expect(neighbor.to.tree).not.toBe(first.to.tree);
          const expectedNeighbor = expectedPatch(cwd, f.repo.base, neighbor.to.tree);
          const ownOrphan = own.writer + crypto.randomUUID() + "/from",
            foreignOrphan = foreign.writer + crypto.randomUUID() + "/from";
          const fixtureHooks = join(f.dir, "fixture-hooks");
          mkdirSync(fixtureHooks);
          for (const orphan of [ownOrphan, foreignOrphan])
            git(cwd, "-c", "core.hooksPath=" + fixtureHooks, "update-ref", orphan, f.repo.base);
          git(
            cwd,
            "-c",
            "core.hooksPath=" + fixtureHooks,
            "symbolic-ref",
            own.writer + "orphan-alias",
            checkpoint,
          );
          await f.daemon.kill();
          expect(existsSync(own.scratch)).toBe(true);
          expect(git(cwd, "rev-parse", own.pair + "/to")).toBe(first.to.tree);

          const restarted = launchWriter(f.state, productRoot);
          try {
            const { instance } = await restarted.ready();
            expect(existsSync(own.scratch)).toBe(false);
            expect(cleanupIntents(f.state)).toHaveLength(0);
            expect(git(cwd, "for-each-ref", "--format=%(refname)", own.writer)).toBe("");
            expect(
              git(
                cwd,
                "rev-parse",
                checkpoint,
                legacy + "/from",
                legacy + "/to",
                foreignOrphan,
              ).split(/\r?\n/),
            ).toEqual(Array(4).fill(f.repo.base));
            expect(git(cwd, "rev-parse", foreign.pair + "/to")).toBe(neighbor.to.tree);
            expect(existsSync(join(foreign.scratch, "patch"))).toBe(true);

            writeFileSync(file, content);
            const lastNeighbor = changed(await otherClient.diff(otherQuery, neighbor.next));
            expect(lastNeighbor.next).toBeNull();
            expect(Buffer.from(neighbor.patch + lastNeighbor.patch).equals(expectedNeighbor)).toBe(
              true,
            );
            expect(cleanupIntents(other.state)).toHaveLength(0);
            expect(existsSync(foreign.scratch)).toBe(false);
            expect(git(cwd, "for-each-ref", "--format=%(refname)", foreign.writer)).toBe(
              foreignOrphan,
            );

            const recovered = await fixtureGitClient(f.credentials, instance.endpoint);
            try {
              const again = changed(await recovered.diff(query));
              if (!again.next || again.to.kind !== "workingTree")
                throw Error("Expected new continuation");
              expect(again.to).toEqual(first.to);
              expect(pinnedComparison(f, again.to.tree).writer).toBe(own.writer);
              const last = changed(await recovered.diff(query, again.next));
              expect(last.next).toBeNull();
              expect(
                Buffer.from(again.patch + last.patch).equals(
                  expectedPatch(cwd, f.repo.base, first.to.tree),
                ),
              ).toBe(true);
              expect(cleanupIntents(f.state)).toHaveLength(0);
              expect(git(cwd, "for-each-ref", "--format=%(refname)", own.writer)).toBe("");
            } finally {
              recovered.close();
            }
          } finally {
            await restarted.stop();
          }
          const diagnostics = await restarted.stderr;
          expect(diagnostics).toContain(
            "Removed orphan comparison ref " + realpathSync.native(common) + " " + ownOrphan,
          );
          expect(diagnostics.split("Preserved legacy comparison refs").length - 1).toBe(1);
          expect(diagnostics).toContain(legacy);
          expect(existsSync(hook + ".called")).toBe(false);
        } finally {
          otherClient.close();
        }
      } finally {
        await other.daemon.close();
      }
      expect(gitMetadataFiles(common)).toEqual(f.metadataBefore);
    }),
  120000,
);
