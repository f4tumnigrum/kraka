import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import * as v from "valibot";

const suiteShell = v.picklist(["bash", "default"]);
const selectedShell = v.parse(v.optional(suiteShell), process.argv[2]);
const logDirectory = process.env.RUNNER_TEMP ?? ".build/live";
await mkdir(logDirectory, { recursive: true });
const suites = Array.from(new Bun.Glob("tools/live/*.live.test.ts").scanSync()).sort();
if (!suites.length) throw Error("No live suites found");
let files = 0,
  cases = 0,
  groups = 0;
for (const path of suites) {
  const source = await Bun.file(path).text();
  const shell = v.parse(suiteShell, /^\/\/ Live shell (.+)$/m.exec(source)?.[1] ?? "default");
  if (selectedShell && selectedShell !== shell) continue;
  files++;
  const env = Object.fromEntries(
    Array.from(source.matchAll(/^\/\/ Live env (\w+)=(.+)$/gm), ([, key, value]) => [key, value]),
  );
  if (shell === "bash") env.NO_COLOR = "1";
  const declared = /^\/\/ Live cases (\d+); required groups (\[[^\n]*\])$/m.exec(source);
  if (!declared) throw Error("Missing live case and group declaration in " + path);
  const required = v.parse(v.array(v.string()), JSON.parse(declared[2] ?? ""));
  const junit = /^\/\/ Live junit ([\w-]+\.xml)$/m.exec(source)?.[1];
  const reports = junit
    ? ["--reporter=junit", "--reporter-outfile=" + join(logDirectory, junit)]
    : [];
  const child = Bun.spawn([process.execPath, "test", "./" + path, ...reports], {
    stdout: "pipe",
    stderr: "pipe",
    ...(Object.keys(env).length && { env: { ...process.env, ...env } }),
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
  const passed = Bun.stripANSI(output)
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
  `Verified ${cases} passing live cases and ${groups} required groups in ${files} suites`,
);
