import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { GitObjectIdSchema, type GitObjectId } from "@kraka/protocol";
import { gitEnvironment, runGit } from "./git-process";
import { physicalDirectory } from "./project-directory";
import { hashId, readManaged } from "./worktree-storage";
import type { FirstSendStore } from "./first-send-store";

const diffRefs = "refs/kraka/diffs/";
const uuid = v.pipe(v.string(), v.uuid());
type Repository = NonNullable<ReturnType<typeof physicalDirectory>>;
type Row = {
  id: string;
  scratch: string;
  common: string;
  identity: string;
  leftOid: GitObjectId | null;
  rightOid: GitObjectId | null;
};
const columns = "id,scratch,common,identity,leftOid,rightOid";

function repository(cwd: string) {
  const result = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return result.exitCode === 0
    ? physicalDirectory(result.stdout.toString().replace(/\r?\n$/, ""))
    : null;
}
function refs(common: string, prefix: string) {
  const r = runGit(common, [
    "--git-dir=.",
    "for-each-ref",
    "--format=%(refname)%00%(objectname)%00%(symref)",
    prefix,
  ]);
  if (r.exitCode !== 0) throw Error("Cannot enumerate comparison refs");
  return r.stdout
    .toString()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [name, oid, symbolic] = line.split("\0");
      if (!name?.startsWith(prefix) || !v.is(GitObjectIdSchema, oid))
        throw Error("Invalid comparison ref");
      return { name, oid, symbolic };
    });
}
function updateArgs(emptyHooks: string) {
  mkdirSync(emptyHooks, { recursive: true, mode: 0o700 });
  if (!lstatSync(emptyHooks).isDirectory() || readdirSync(emptyHooks).length)
    throw Error("Comparison hooks directory must be empty");
  return [
    "--git-dir=.",
    "-c",
    `core.hooksPath=${emptyHooks}`,
    "-c",
    "core.filesRefLockTimeout=5000",
    "update-ref",
    "--no-deref",
    "--stdin",
  ];
}
function updateRefs(common: string, emptyHooks: string, commands: string) {
  return runGit(common, updateArgs(emptyHooks), { input: Buffer.from(commands) }).exitCode === 0;
}
async function publishPair(common: string, emptyHooks: string, commands: string) {
  const child = Bun.spawn(["git", "-C", common, ...updateArgs(emptyHooks)], {
    env: gitEnvironment(),
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10000,
  });
  let reply = "",
    committed = false;
  try {
    child.stdin.write(`start\n${commands}prepare\n`);
    await child.stdin.flush();
    for await (const part of child.stdout) {
      reply += Buffer.from(part).toString("ascii");
      // Before prepare, losing the parent closes stdin and aborts. After prepare,
      // recovery must acquire these same ref locks before it can confirm absence.
      if (!committed && /(?:^|\n)prepare: ok\r?\n/.test(reply)) {
        committed = true;
        child.stdin.write("commit\n");
        await child.stdin.end();
      }
    }
    return committed && (await child.exited) === 0;
  } finally {
    if (!committed) await child.stdin.end();
    await child.exited;
  }
}

export class DiffCleanup {
  readonly namespace: string;
  private readonly scratchRoot: string;
  private readonly emptyHooks: string;
  constructor(
    private readonly db: Database,
    stateDirectory: string,
    environmentId: string,
  ) {
    const state = realpathSync.native(stateDirectory);
    this.namespace = `${diffRefs}w-${hashId(JSON.stringify([environmentId, state]))}/`;
    this.scratchRoot = join(state, "diff-scratch");
    this.emptyHooks = join(state, "diff-empty-hooks");
    db.exec(
      "CREATE TABLE IF NOT EXISTS diff_cleanup(id TEXT PRIMARY KEY,scratch TEXT NOT NULL,common TEXT NOT NULL,identity TEXT NOT NULL,leftOid TEXT,rightOid TEXT)",
    );
  }

  begin(cwd: string) {
    const repo = repository(cwd);
    if (!repo) return null;
    mkdirSync(this.scratchRoot, { recursive: true, mode: 0o700 });
    if (!lstatSync(this.scratchRoot).isDirectory()) throw Error("Invalid comparison scratch root");
    const id = crypto.randomUUID(),
      scratch = join(this.scratchRoot, `kraka-diff-${id}`);
    // Commit the cleanup intent before creating scratch or publishing either endpoint.
    this.db.run("INSERT INTO diff_cleanup(id,scratch,common,identity) VALUES(?,?,?,?)", [
      id,
      scratch,
      repo.realPath,
      repo.identity,
    ]);
    try {
      mkdirSync(scratch, { mode: 0o700 });
      return { id, scratch };
    } catch (error) {
      this.db.run("DELETE FROM diff_cleanup WHERE id=?", [id]);
      throw error;
    }
  }
  private row(id: string) {
    return this.db.query<Row, [string]>(`SELECT ${columns} FROM diff_cleanup WHERE id=?`).get(id);
  }
  async pin(id: string, left: GitObjectId, right: GitObjectId) {
    const row = this.row(id);
    if (!row || physicalDirectory(row.common)?.identity !== row.identity) return false;
    this.db.run("UPDATE diff_cleanup SET leftOid=?,rightOid=? WHERE id=?", [left, right, id]);
    const prefix = this.namespace + id;
    return publishPair(
      row.common,
      this.emptyHooks,
      `create ${prefix}/from ${left}\ncreate ${prefix}/to ${right}\n`,
    );
  }
  release(id: string) {
    const row = this.row(id);
    if (!row) return;
    try {
      const name = `kraka-diff-${v.parse(uuid, id)}`;
      const legacy = row.scratch === join(tmpdir(), name);
      if (!legacy && row.scratch !== join(this.scratchRoot, name))
        throw Error("Unrecognized comparison scratch path");
      if (!legacy && lstatSync(this.scratchRoot, { throwIfNoEntry: false })?.isSymbolicLink())
        throw Error("Invalid comparison scratch root");
      rmSync(row.scratch, { recursive: true, force: true });
      if ((row.leftOid === null) !== (row.rightOid === null))
        throw Error("Incomplete comparison endpoints");
      if (!legacy && row.leftOid !== null && row.rightOid !== null) {
        if (physicalDirectory(row.common)?.identity !== row.identity)
          throw Error("Git directory unavailable or replaced");
        let complete = true;
        const prefix = this.namespace + id + "/";
        for (const [side, expected] of [
          ["from", row.leftOid],
          ["to", row.rightOid],
        ] as const) {
          const name = prefix + side;
          if (!v.is(GitObjectIdSchema, expected)) throw Error("Invalid pinned object ID");
          const present = runGit(row.common, [
            "--git-dir=.",
            "show-ref",
            "--exists",
            name,
          ]).exitCode;
          if (
            present === 2 &&
            updateRefs(
              row.common,
              this.emptyHooks,
              `verify ${name} ${"0".repeat(expected.length)}\n`,
            )
          )
            continue;
          const direct =
            runGit(row.common, ["--git-dir=.", "symbolic-ref", "--quiet", "--no-recurse", name])
              .exitCode === 1;
          if (!direct || !updateRefs(row.common, this.emptyHooks, `delete ${name} ${expected}\n`))
            complete = false;
        }
        if (!complete) throw Error("A pinned ref changed or is still locked");
      }
      this.db.run("DELETE FROM diff_cleanup WHERE id=?", [id]);
    } catch (error) {
      console.warn("Comparison cleanup deferred", id, String(error));
    }
  }
  /** Called once under the state-directory writer lock, before opening any client connection. */
  recover(store: FirstSendStore) {
    const repositories = new Map<string, Repository>();
    for (const row of this.db.query<Row, []>(`SELECT ${columns} FROM diff_cleanup`).all()) {
      const repo = physicalDirectory(row.common);
      if (repo?.identity === row.identity) repositories.set(repo.realPath, repo);
      this.release(row.id);
    }
    for (const { id } of this.db
      .query<{ id: string }, [string]>("SELECT id FROM projects WHERE environment=?")
      .all(store.writer.environmentId)) {
      const cwd = store.projectDirectory(id);
      const repo = cwd && repository(cwd);
      if (repo) repositories.set(repo.realPath, repo);
    }
    for (const { id } of this.db
      .query<{ id: string }, []>("SELECT id FROM managed_worktrees")
      .all()) {
      const managed = readManaged(this.db, id);
      if (
        managed &&
        physicalDirectory(managed.common.realPath)?.identity === managed.common.identity
      )
        repositories.set(managed.common.realPath, managed.common);
    }
    for (const repo of repositories.values()) {
      try {
        const common = repo.realPath;
        const legacy = runGit(common, [
          "--git-dir=.",
          "for-each-ref",
          "--count=1",
          "--format=%(refname)",
          `--exclude=${diffRefs}w-*/*`,
          `${diffRefs}*/*`,
        ]);
        if (legacy.exitCode !== 0) throw Error("Cannot inspect legacy comparison refs");
        if (legacy.stdout.length)
          console.warn(
            "Preserved legacy comparison refs",
            common,
            legacy.stdout.toString().trimEnd(),
          );
        const registered = new Set(
          this.db
            .query<{ id: string }, [string]>("SELECT id FROM diff_cleanup WHERE common=?")
            .all(common)
            .map((row) => row.id),
        );
        for (const ref of refs(common, this.namespace)) {
          const parts = ref.name.slice(this.namespace.length).split("/");
          if (
            parts.length === 2 &&
            (parts[1] === "from" || parts[1] === "to") &&
            registered.has(parts[0] ?? "")
          )
            continue;
          const command = ref.symbolic
            ? `symref-delete ${ref.name} ${ref.symbolic}\n`
            : `delete ${ref.name} ${ref.oid}\n`;
          if (updateRefs(common, this.emptyHooks, command))
            console.warn("Removed orphan comparison ref", common, ref.name, ref.oid);
          else console.warn("Orphan comparison ref needs inspection", common, ref.name);
        }
      } catch (error) {
        console.warn("Comparison ref scan deferred", repo.realPath, String(error));
      }
    }
  }
}
