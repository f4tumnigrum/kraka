import { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import * as v from "valibot";
import { GitObjectIdSchema, type GitObjectId } from "@kraka/protocol";
import { gitEnvironment, runGit } from "./git-process";
import { physicalDirectory } from "./project-directory";
import { readManaged } from "./worktree-storage";
import type { FirstSendStore } from "./first-send-store";

const namespace = "refs/kraka/diffs/";
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
function updateArgs(common: string) {
  // No repository hooks run for the service's private refs.
  return [
    "--git-dir=.",
    "-c",
    `core.hooksPath=${join(common, "kraka-diff-owners.sqlite", "hooks")}`,
    "-c",
    "core.filesRefLockTimeout=5000",
    "update-ref",
    "--no-deref",
    "--stdin",
  ];
}
function updateRefs(common: string, commands: string) {
  return runGit(common, updateArgs(common), { input: Buffer.from(commands) }).exitCode === 0;
}
async function publishPair(common: string, commands: string) {
  const child = Bun.spawn(["git", "-C", common, ...updateArgs(common)], {
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

/** Worktrees and independent environment writers can share one Git ref database. Serialize orphan scans with pin registration. */
function withOwners<T>(common: string, work: (db: Database) => T) {
  const path = join(common, "kraka-diff-owners.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const st = lstatSync(path + suffix, { throwIfNoEntry: false });
    if (st && (!st.isFile() || st.nlink !== 1)) throw Error("Invalid comparison owner database");
  }
  const db = new Database(path, { create: true, strict: true });
  try {
    db.exec(
      "PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; CREATE TABLE IF NOT EXISTS owners(id TEXT PRIMARY KEY, owner TEXT NOT NULL)",
    );
    return db.transaction(() => work(db)).immediate();
  } finally {
    db.close(true);
  }
}

export class DiffCleanup {
  constructor(
    private readonly db: Database,
    private readonly state: string,
  ) {
    db.exec(
      "CREATE TABLE IF NOT EXISTS diff_cleanup(id TEXT PRIMARY KEY,scratch TEXT NOT NULL,common TEXT NOT NULL,identity TEXT NOT NULL,leftOid TEXT,rightOid TEXT)",
    );
  }

  begin(cwd: string) {
    const repo = repository(cwd);
    if (!repo) return null;
    const id = crypto.randomUUID(),
      scratch = join(tmpdir(), `kraka-diff-${id}`);
    // This committed ID names both refs. Record the actual temp path even if TMPDIR changes on restart.
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
    // Commit the shared reservation before Git can publish either endpoint.
    withOwners(row.common, (db) => db.run("INSERT INTO owners VALUES(?,?)", [id, this.state]));
    const prefix = namespace + id;
    return publishPair(row.common, `create ${prefix}/from ${left}\ncreate ${prefix}/to ${right}\n`);
  }
  release(id: string) {
    const row = this.row(id);
    if (!row) return;
    try {
      if (!isAbsolute(row.scratch) || basename(row.scratch) !== `kraka-diff-${v.parse(uuid, id)}`)
        throw Error("Unrecognized scratch path");
      rmSync(row.scratch, { recursive: true, force: true });
      if ((row.leftOid === null) !== (row.rightOid === null))
        throw Error("Incomplete comparison endpoints");
      if (row.leftOid !== null && row.rightOid !== null) {
        if (physicalDirectory(row.common)?.identity !== row.identity)
          throw Error("Git directory unavailable or replaced");
        const done = withOwners(row.common, (db) => {
          const owner = db
            .query<{ owner: string }, [string]>("SELECT owner FROM owners WHERE id=?")
            .get(id);
          if (owner && owner.owner !== this.state) return false;
          let complete = true;
          const prefix = namespace + id + "/";
          for (const [side, expected] of [
            ["from", row.leftOid],
            ["to", row.rightOid],
          ] as const) {
            const name = prefix + side;
            if (!expected || !v.is(GitObjectIdSchema, expected)) return false;
            const present = runGit(row.common, [
              "--git-dir=.",
              "show-ref",
              "--exists",
              name,
            ]).exitCode;
            if (
              present === 2 &&
              updateRefs(row.common, `verify ${name} ${"0".repeat(expected.length)}\n`)
            )
              continue;
            const direct =
              runGit(row.common, ["--git-dir=.", "symbolic-ref", "--quiet", "--no-recurse", name])
                .exitCode === 1;
            if (!direct || !updateRefs(row.common, `delete ${name} ${expected}\n`))
              complete = false;
          }
          if (complete) db.run("DELETE FROM owners WHERE id=? AND owner=?", [id, this.state]);
          return complete;
        });
        if (!done) throw Error("A pinned ref changed or is still locked");
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
        // Do not create a repository-side database just to discover an empty namespace.
        if (!refs(common, namespace).length) continue;
        withOwners(common, (db) => {
          const registered = new Set(
            db
              .query<{ id: string }, []>("SELECT id FROM owners")
              .all()
              .map((r) => r.id),
          );
          for (const r of this.db
            .query<{ id: string }, [string]>("SELECT id FROM diff_cleanup WHERE common=?")
            .all(common))
            registered.add(r.id);
          for (const ref of refs(common, namespace)) {
            const parts = ref.name.slice(namespace.length).split("/");
            if (
              parts.length === 2 &&
              (parts[1] === "from" || parts[1] === "to") &&
              registered.has(parts[0] ?? "")
            )
              continue;
            if (
              updateRefs(
                common,
                ref.symbolic
                  ? `symref-delete ${ref.name} ${ref.symbolic}\n`
                  : `delete ${ref.name} ${ref.oid}\n`,
              )
            )
              console.warn("Removed orphan comparison ref", common, ref.name, ref.oid);
            else console.warn("Orphan comparison ref needs inspection", common, ref.name);
          }
        });
      } catch (error) {
        console.warn("Comparison ref scan deferred", repo.realPath, String(error));
      }
    }
  }
}
