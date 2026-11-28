import type { Database } from "bun:sqlite";
import type { DirectoryBinding } from "@kraka/protocol";
import { CheckpointCaptureSchema, GitObjectIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import type { RepositoryIdentity } from "./capture-boundary";

const schema = `
CREATE TABLE IF NOT EXISTS capture_sources (
  id INTEGER PRIMARY KEY, binding TEXT NOT NULL, repo TEXT NOT NULL, UNIQUE(binding,repo)
);
CREATE TABLE IF NOT EXISTS capture_intents (
  round TEXT NOT NULL, attempt TEXT NOT NULL, id TEXT NOT NULL, source INTEGER NOT NULL,
  baseline TEXT, seal TEXT, failure TEXT, PRIMARY KEY(round,attempt)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS round_captures (
  id TEXT PRIMARY KEY, source INTEGER NOT NULL, partial_before TEXT, owners TEXT
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS capture_cleanup (path TEXT PRIMARY KEY) WITHOUT ROWID;`;

function captureSource(db: Database, binding: string, repo: string) {
  db.run("INSERT INTO capture_sources(binding,repo) VALUES(?,?) ON CONFLICT DO NOTHING", [
    binding,
    repo,
  ]);
  const row = db
    .query<{ id: number }, [string, string]>(
      "SELECT id FROM capture_sources WHERE binding=? AND repo=?",
    )
    .get(binding, repo);
  if (!row) throw Error("Missing capture source");
  return row.id;
}
export function bindCaptureSource(
  db: Database,
  binding: DirectoryBinding,
  repo: (RepositoryIdentity & { writer: string }) | null,
) {
  return captureSource(db, JSON.stringify(binding), repo ? JSON.stringify(repo) : "");
}
export type CaptureIntent = {
  id: string;
  round: string;
  attempt: string;
  binding: string;
  repo: string;
  source: number;
  baseline: string | null;
  seal: string | null;
  failure: string | null;
};
const intents =
  "SELECT i.*,s.binding,s.repo FROM capture_intents i JOIN capture_sources s ON s.id=i.source";
export function readIntent(db: Database, round: string, attempt: string) {
  return db
    .query<CaptureIntent, [string, string]>(intents + " WHERE i.round=? AND i.attempt=?")
    .get(round, attempt);
}
export function pendingBaselines(db: Database) {
  return db
    .query<CaptureIntent, []>(intents + " WHERE i.baseline IS NULL AND i.failure IS NULL")
    .all();
}
type PreviousRow = {
  seal: string | null;
  id: string;
  round: string;
  attempt: string;
  thread: string;
  binding: string;
  repo: string | null;
  baseline: string | null;
  result: string | null;
  owners: string | null;
  scratch: string | null;
  cleanup: number;
};
export function openCaptureStorage(db: Database) {
  db.transaction(() => {
    const previous = db
      .query("SELECT 1 FROM pragma_table_info('round_captures') WHERE name='seq'")
      .get();
    if (previous) db.run("ALTER TABLE round_captures RENAME TO previous_captures");
    db.exec(schema);
    if (!previous) return;
    for (const row of db.query<PreviousRow, []>("SELECT * FROM previous_captures").iterate()) {
      const source = captureSource(db, row.binding, row.repo ?? "");
      const baseline = row.baseline
        ? v.parse(GitObjectIdSchema, JSON.parse(row.baseline).commit)
        : null;
      const result = row.result
        ? v.parse(CheckpointCaptureSchema, JSON.parse(row.result)).result
        : null;
      const published = db
        .query("SELECT 1 FROM sync_rows WHERE source=? AND key=?")
        .get(row.thread, JSON.stringify(["checkpointCapture", row.id]));
      if (published && result) {
        if (baseline && row.repo)
          db.run("INSERT INTO round_captures VALUES(?,?,?,?)", [
            row.id,
            source,
            result.kind === "ready" ? null : baseline,
            row.owners,
          ]);
      } else {
        db.run(
          "INSERT INTO capture_intents(round,attempt,id,source,baseline,seal,failure) VALUES(?,?,?,?,?,?,?)",
          [
            row.round,
            row.attempt,
            row.id,
            source,
            baseline,
            row.seal,
            result ? JSON.stringify(result) : null,
          ],
        );
      }
      if (row.cleanup && row.scratch)
        db.run("INSERT OR IGNORE INTO capture_cleanup VALUES(?)", [row.scratch]);
    }
    db.run("DROP TABLE previous_captures");
  })();
}
