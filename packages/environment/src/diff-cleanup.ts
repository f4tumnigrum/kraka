import type { Database } from "bun:sqlite";
import { lstatSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { GitObjectIdSchema, type GitObjectId } from "@kraka/protocol";
import { gitCommand, gitEnvironment, gitRepositoryIdentity, runGit } from "./git-process";
import { physicalDirectory } from "./project-directory";
import { privateDirectory, privateHooks, type writerGitPaths } from "./private-git";
import type { WriterRecovery } from "./writer-recovery";

const diffRefs = "refs/kraka/diffs/";
const uuid = v.pipe(v.string(), v.uuid());
type ComparedRepository = { common: string; identity: string; legacyRef: string | null };
type Row = {
  id: string;
  scratch: string;
  common: string;
  identity: string;
  leftOid: GitObjectId | null;
  rightOid: GitObjectId | null;
};
const columns = "id,scratch,common,identity,leftOid,rightOid";

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
function updateArgs(state: string) {
  return [
    "--git-dir=.",
    "-c",
    privateHooks(state),
    "-c",
    "core.filesRefLockTimeout=5000",
    "update-ref",
    "--no-deref",
    "--stdin",
  ];
}
function updateRefs(common: string, state: string, commands: string) {
  return runGit(common, updateArgs(state), { input: Buffer.from(commands) }).exitCode === 0;
}
async function publishPair(common: string, state: string, commands: string) {
  const child = Bun.spawn(gitCommand(common, updateArgs(state)), {
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
  constructor(
    private readonly db: Database,
    private readonly paths: ReturnType<typeof writerGitPaths>,
  ) {
    this.namespace = `${diffRefs}${paths.writer}/`;
    db.exec(`
      CREATE TABLE IF NOT EXISTS diff_cleanup(id TEXT PRIMARY KEY,scratch TEXT NOT NULL,common TEXT NOT NULL,identity TEXT NOT NULL,leftOid TEXT,rightOid TEXT);
      CREATE TABLE IF NOT EXISTS compared_repositories(identity TEXT PRIMARY KEY,common TEXT NOT NULL,legacyRef TEXT);
    `);
  }

  begin(cwd: string, expectedRepo?: NonNullable<ReturnType<typeof gitRepositoryIdentity>>) {
    const repo = gitRepositoryIdentity(cwd);
    if (!repo || (expectedRepo && !Bun.deepEquals(repo, expectedRepo))) return null;
    privateDirectory(this.paths.diffScratch);
    const id = crypto.randomUUID(),
      scratch = join(this.paths.diffScratch, `kraka-diff-${id}`);
    // Commit the cleanup intent before creating scratch or publishing either endpoint.
    this.db.transaction(() => {
      this.db.run(
        "INSERT INTO compared_repositories(identity,common) VALUES(?,?) ON CONFLICT(identity) DO UPDATE SET common=excluded.common WHERE common<>excluded.common",
        [repo.identity, repo.realPath],
      );
      this.db.run("INSERT INTO diff_cleanup(id,scratch,common,identity) VALUES(?,?,?,?)", [
        id,
        scratch,
        repo.realPath,
        repo.identity,
      ]);
    })();
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
      this.paths.state,
      `create ${prefix}/from ${left}\ncreate ${prefix}/to ${right}\n`,
    );
  }
  release(id: string) {
    const row = this.row(id);
    if (!row) return;
    try {
      const name = `kraka-diff-${v.parse(uuid, id)}`;
      const legacy = row.scratch === join(tmpdir(), name);
      if (!legacy && row.scratch !== join(this.paths.diffScratch, name))
        throw Error("Unrecognized comparison scratch path");
      if (!legacy && lstatSync(this.paths.diffScratch, { throwIfNoEntry: false })?.isSymbolicLink())
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
              this.paths.state,
              `verify ${name} ${"0".repeat(expected.length)}\n`,
            )
          )
            continue;
          const direct =
            runGit(row.common, ["--git-dir=.", "symbolic-ref", "--quiet", "--no-recurse", name])
              .exitCode === 1;
          if (!direct || !updateRefs(row.common, this.paths.state, `delete ${name} ${expected}\n`))
            complete = false;
        }
        if (!complete) throw Error("A pinned ref changed or is still locked");
      }
      this.db.run("DELETE FROM diff_cleanup WHERE id=?", [id]);
    } catch (error) {
      console.warn("Comparison cleanup deferred", id, String(error));
    }
  }
  private inspectLegacy(repo: ComparedRepository) {
    // NULL is pending. An empty result records that Git found no legacy ref.
    if (repo.legacyRef !== null) return;
    const result = runGit(repo.common, [
      "--git-dir=.",
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      `--exclude=${diffRefs}w-*/*`,
      `${diffRefs}*/*`,
    ]);
    if (result.exitCode !== 0) {
      console.warn("Legacy comparison ref scan deferred", repo.common);
      return;
    }
    const firstRef = result.stdout.toString().trimEnd();
    this.db.run("UPDATE compared_repositories SET legacyRef=? WHERE identity=?", [
      firstRef,
      repo.identity,
    ]);
    if (firstRef) console.warn("Preserved legacy comparison refs", repo.common, firstRef);
  }
  registerRecovery(recovery: WriterRecovery) {
    const pending = this.db
      .query<Pick<Row, "id" | "common" | "identity">, []>(
        "SELECT id,common,identity FROM diff_cleanup",
      )
      .all();
    for (const row of pending) {
      // Older databases can have unfinished intents but no repository history.
      this.db.run("INSERT OR IGNORE INTO compared_repositories(identity,common) VALUES(?,?)", [
        row.identity,
        row.common,
      ]);
      recovery.register(row.identity, () => this.release(row.id));
    }
    for (const repo of this.db
      .query<ComparedRepository, []>("SELECT common,identity,legacyRef FROM compared_repositories")
      .all()) {
      recovery.register(repo.identity, () => this.scanRepository(repo));
    }
  }

  private scanRepository(repo: ComparedRepository) {
    const common = repo.common;
    if (physicalDirectory(common)?.identity !== repo.identity) return;
    try {
      this.inspectLegacy(repo);
      const registered = new Set(
        this.db
          .query<{ id: string }, [string]>("SELECT id FROM diff_cleanup WHERE identity=?")
          .all(repo.identity)
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
        if (updateRefs(common, this.paths.state, command))
          console.warn("Removed orphan comparison ref", common, ref.name, ref.oid);
        else console.warn("Orphan comparison ref needs inspection", common, ref.name);
      }
    } catch (error) {
      console.warn("Comparison ref scan deferred", repo.common, String(error));
    }
  }
}
