import type { Database } from "bun:sqlite";

const ident = (s: string) => '"' + s.replaceAll('"', '""') + '"';
export function p10DatabaseBytes(db: Database) {
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
  const pages = db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
  const free = db
    .query<{ freelist_count: number }, []>("PRAGMA freelist_count")
    .get()!.freelist_count;
  const schema = db
    .query<{ name: string; tbl_name: string; type: string }, []>(
      "SELECT name,tbl_name,type FROM sqlite_schema WHERE type IN ('table','index')",
    )
    .all();
  try {
    const trees = db
      .query<{ name: string; bytes: number; payload: number; cells: number }, []>(
        "SELECT name,sum(pgsize) AS bytes,sum(payload) AS payload,sum(ncell) AS cells FROM dbstat GROUP BY name ORDER BY name",
      )
      .all();
    // Rebuild only the two mixed tables in RAM to compare their original business rows
    // at the same packing density. The reported on-disk totals above include every row.
    db.run("ATTACH ':memory:' AS old_work");
    try {
      db.run("PRAGMA old_work.page_size=" + pageSize);
      for (const [table, filter] of [
        ["sync_rows", "json_extract(key,'$[0]') <> 'checkpointCapture'"],
        ["turn_work", "kind <> 'capture'"],
      ] as const) {
        const ddl = db
          .query<{ sql: string }, [string]>(
            "SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=?",
          )
          .get(table);
        if (!ddl) throw Error("Missing P10 table " + table);
        db.run(ddl.sql.replace("CREATE TABLE " + table, "CREATE TABLE old_work." + table));
        db.run(
          "INSERT INTO old_work." +
            table +
            "(rowid," +
            db
              .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
              .all(table)
              .map((c) => ident(c.name))
              .join(",") +
            ") SELECT rowid,* FROM main." +
            table +
            " WHERE " +
            filter +
            " ORDER BY rowid",
        );
      }
      const originalRows = db
        .query<{ name: string; bytes: number; payload: number }, []>(
          "SELECT name,sum(pgsize) AS bytes,sum(payload) AS payload FROM dbstat('old_work') WHERE name<>'sqlite_schema' GROUP BY name ORDER BY name",
        )
        .all();
      return {
        method: "dbstat",
        pageSize,
        pages,
        free,
        originalRows,
        trees: trees.map((t) => ({
          ...t,
          table: schema.find(({ name }) => name === t.name)?.tbl_name ?? t.name,
        })),
      };
    } finally {
      db.run("DETACH old_work");
    }
  } catch (e) {
    if (!(e instanceof Error) || !e.message.includes("no such table: dbstat")) throw e;
    const tables = schema
      .filter((row) => row.type === "table")
      .map(({ name }) => {
        const columns = db
          .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
          .all(name);
        const terms = columns.map((c) => "coalesce(length(cast(" + ident(c.name) + " as blob)),0)");
        const payload = db
          .query<{ n: number }, []>(
            "SELECT coalesce(sum(" + terms.join("+") + "),0) n FROM " + ident(name),
          )
          .get()!.n;
        return { name, payload };
      });
    return { method: "column lengths and total pages", pageSize, pages, free, tables };
  }
}
