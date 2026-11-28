import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { openCaptureStorage, readIntent } from "./capture-storage";

test("upgrading sealed, failed and published attempts retains recovery inputs only until settlement", () => {
  const db = new Database(":memory:");
  try {
    db.exec(
      "CREATE TABLE sync_rows(source TEXT,key TEXT); CREATE TABLE round_captures(seq INTEGER PRIMARY KEY,id TEXT UNIQUE,thread TEXT,round TEXT,attempt TEXT UNIQUE,binding TEXT,repo TEXT,baseline TEXT,end TEXT,seal TEXT,result TEXT,owners TEXT,scratch TEXT,cleanup INTEGER DEFAULT 0)",
    );
    const binding = JSON.stringify({ kind: "projectRoot", directoryId: "dir", generation: "1" }),
      repo = JSON.stringify({ realPath: "repo", identity: "disk" });
    const commit = "a".repeat(40),
      baseline = JSON.stringify({ commit }),
      seal = JSON.stringify({ tree: "tree" });
    const insert = db.query(
      "INSERT INTO round_captures(id,thread,round,attempt,binding,repo,baseline,seal,result,owners,scratch,cleanup) VALUES(?,'thread',?,?,?, ?,?,?,?,?,?,?)",
    );
    const record = (id: string, result: object) =>
      JSON.stringify({ id, roundId: id, attemptId: id, version: "1", result });
    const ready = {
      kind: "ready",
      directoryId: "dir",
      generation: "1",
      comparison: { before: commit, after: "b".repeat(40), summary: { kind: "empty" } },
    };
    for (const id of ["complete", "partial", "unpublished", "before-failure"]) {
      const result =
        id === "complete"
          ? ready
          : id === "partial"
            ? { kind: "error", boundary: "after", reason: "gone" }
            : { kind: "missing", boundary: "before", reason: "noRepository" };
      insert.run(
        id,
        id,
        id,
        binding,
        repo,
        id === "before-failure" ? null : baseline,
        id === "unpublished" ? seal : null,
        id === "unpublished" ? null : record(id, result),
        id === "complete" ? "[]" : null,
        id === "partial" ? "cleanup-dir" : null,
        Number(id === "partial"),
      );
      if (id === "complete" || id === "partial")
        db.run("INSERT INTO sync_rows VALUES('thread',?)", [
          JSON.stringify(["checkpointCapture", id]),
        ]);
    }
    openCaptureStorage(db);
    openCaptureStorage(db);
    expect(db.query("SELECT count(*) AS n FROM capture_sources").get()).toEqual({ n: 1 });
    expect(
      db.query("SELECT id,partial_before,owners FROM round_captures ORDER BY id").all(),
    ).toEqual([
      { id: "complete", partial_before: null, owners: "[]" },
      { id: "partial", partial_before: commit, owners: null },
    ]);
    expect(readIntent(db, "complete", "complete")).toBeNull();
    expect(readIntent(db, "unpublished", "unpublished")).toMatchObject({ seal, baseline: commit });
    expect(JSON.parse(readIntent(db, "before-failure", "before-failure")!.failure!)).toMatchObject({
      kind: "missing",
      boundary: "before",
    });
    expect(db.query("SELECT path FROM capture_cleanup").all()).toEqual([{ path: "cleanup-dir" }]);
  } finally {
    db.close(true);
  }
});
