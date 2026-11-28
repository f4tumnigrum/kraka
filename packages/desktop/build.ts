import { mkdir, copyFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
const out = join(import.meta.dir, "../../.build/desktop");
await mkdir(out, { recursive: true });
for (const entry of ["main", "preload"]) {
  const result = await Bun.build({
    entrypoints: [join(import.meta.dir, "src", entry + (entry === "preload" ? ".js" : ".ts"))],
    format: "cjs",
    target: "node",
    external: ["electron"],
    outdir: out,
    naming: entry + ".cjs",
  });
  if (!result.success) throw new AggregateError(result.logs, "Desktop build failed");
}
for (const file of ["thread.html", "thread.js"])
  await copyFile(join(import.meta.dir, "src", file), join(out, file));
await writeFile(
  join(out, "package.json"),
  JSON.stringify({ name: "kraka-desktop", version: "0.1.0", main: "main.cjs" }),
);
