import { Database } from "bun:sqlite";
import { emptyThreadCache, type ThreadCache, type ThreadCacheStore } from "@kraka/client-runtime";

export class SqliteThreadCache implements ThreadCacheStore {
  private readonly database: Database;
  constructor(
    path: string,
    readonly namespace: string,
  ) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec(
      "PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS thread_caches(namespace TEXT PRIMARY KEY,format INTEGER NOT NULL,data TEXT NOT NULL)",
    );
  }
  read(): ThreadCache {
    const row = this.database
      .query<{ format: number; data: string }, [string]>(
        "SELECT format,data FROM thread_caches WHERE namespace=?",
      )
      .get(this.namespace);
    return row?.format === 1 ? JSON.parse(row.data) : emptyThreadCache();
  }
  async transact<T>(edit: (current: ThreadCache) => { next: ThreadCache; result: T }): Promise<T> {
    // Let the socket drain ready frames before acquiring the synchronous SQLite write lease.
    await new Promise<void>((resolve) => setImmediate(resolve));
    return this.database
      .transaction(() => {
        const old = this.read(),
          { next, result } = edit(old);
        if (next !== old)
          this.database.run(
            "INSERT INTO thread_caches VALUES(?,1,?) ON CONFLICT(namespace) DO UPDATE SET format=1,data=excluded.data",
            [this.namespace, JSON.stringify(next)],
          );
        return result;
      })
      .immediate();
  }
  close() {
    this.database.close();
  }
}
