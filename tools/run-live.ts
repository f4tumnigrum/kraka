import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import * as v from "valibot";

const logDirectory = process.env.RUNNER_TEMP ?? ".build/live";
await mkdir(logDirectory, { recursive: true });
const suites = Array.from(new Bun.Glob("tools/live/*.live.test.ts").scanSync()).sort();
if (!suites.length) throw Error("No live suites found");
let cases = 0,
  groups = 0;
for (const path of suites) {
  const source = await Bun.file(path).text();
  const declared = /^\/\/ Live cases (\d+); required groups (\[[^\n]*\])$/m.exec(source);
  if (!declared) throw Error("Missing live case and group declaration in " + path);
  const required = v.parse(v.array(v.string()), JSON.parse(declared[2] ?? ""));
  const child = Bun.spawn([process.execPath, "test", "./" + path], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const output = stdout + stderr;
  const name = path.replaceAll("\\", "/").split("/").at(-1)?.split(".")[0];
  await Bun.write(join(logDirectory, name + ".log"), output);
  process.stdout.write(output);
  if (code !== 0) throw Error(path + " failed with exit " + code);
  const passed = output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("(pass) "))
    .map((line) => line.slice(7).split(" > ").at(-1) ?? "");
  if (passed.length !== Number(declared[1]))
    throw Error(path + " expected " + declared[1] + " passing cases, saw " + passed.length);
  for (const group of required)
    if (!passed.some((title) => title.startsWith(group + " ")))
      throw Error(path + " missing passing group " + group);
  cases += passed.length;
  groups += required.length;
}
console.log(
  `Verified ${cases} passing live cases and ${groups} required groups in ${suites.length} suites`,
);
