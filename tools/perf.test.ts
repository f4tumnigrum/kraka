import { expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { withState } from "./fixtures/replay-process";
import { parseSelection, runBudget, summarize, type ProbeReport } from "./perf";
import { metricIds, type Metric } from "./perf-catalog";

const product = resolve(import.meta.dir, "..");
async function run(root: string, ...metrics: Metric[]) {
  const reports: ProbeReport[] = [];
  const exit = await runBudget({
    metrics,
    root,
    role: "candidate",
    writeReport: (r) => reports.push(r),
  });
  return { exit, reports };
}
async function put(root: string, path: string, value: string | object) {
  const full = join(root, path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, typeof value === "string" ? value : JSON.stringify(value));
}

test("selection checks all IDs and roots before starting any workload", () => {
  expect(parseSelection([])).toEqual({
    metrics: [...metricIds],
    root: resolve("."),
    role: "candidate",
  });
  expect(parseSelection(["P2", "--baseline-root", "abc"])).toEqual({
    metrics: ["P2"],
    root: resolve("abc"),
    role: "baseline",
  });
  expect(() => parseSelection(["P1", "P12"])).toThrow("Unknown metric");
  expect(() => parseSelection(["--root", ".", "--baseline-root", "."])).toThrow("Choose one");
});

test("an absent endpoint produces no samples, a broken capability check fails", async () => {
  await withState(async (dir) => {
    await put(
      dir,
      "packages/daemon/src/index.ts",
      'console.error("Unknown command, expected replay, start, access or daemon");process.exit(1)',
    );
    const { exit, reports } = await run(dir, "P4");
    expect(exit).toBe(0);
    expect(reports[0]).toMatchObject({
      metric: "P4",
      status: "unavailable",
      samples: [],
      actual: { capabilityChecks: 1, workloadSamples: 0 },
    });
    expect(reports[0]).not.toHaveProperty("summary");
  });
  await withState(async (dir) => {
    const broken = await run(dir, "P4");
    expect(broken.exit).toBe(1);
    expect(broken.reports[0]).toMatchObject({ status: "failed", actual: { capabilityChecks: 0 } });
  });
});

test("a wrong receipt invalidates a fast run and preserves its real counts", async () => {
  await withState(async (dir) => {
    await put(
      dir,
      "packages/daemon/src/index.ts",
      `
      const server=Bun.serve({hostname:"127.0.0.1",port:0,
        fetch(req,srv){if(!srv.upgrade(req))return new Response(null,{status:404})},
        websocket:{message(ws){ws.send(JSON.stringify({kind:"rejected",commandId:"another-command",failure:{kind:"unsupported"}}));ws.close(1000)}}});
      const ready=JSON.stringify({kind:"ready",url:"ws://127.0.0.1:"+server.port+"/replay"})+"\\n";
      await Bun.write(process.argv[process.argv.indexOf("--state-dir")+1]+"/replay-endpoint.json",ready);
      process.on("SIGTERM",()=>server.stop(true));process.stdout.write(ready);`,
    );
    const { exit, reports } = await run(dir, "P2");
    expect(exit).toBe(1);
    expect(reports[0]).toMatchObject({
      status: "failed",
      error: expect.stringContaining("Unexpected command receipt"),
      samples: [],
      expected: { launches: 10 },
      actual: { launches: 1, accepted: 0, ended: 0, normalCloses: 0, joined: 1 },
    });
  });
});

test("a shared dependency counts once, selected native and optional packages are visible", async () => {
  await withState(async (dir) => {
    const dep = { dependencies: { first: "1", shared: "1" }, devDependencies: { unused: "1" } };
    const optional = { optionalDependencies: { native: "1", foreign: "1" } };
    await put(dir, "packages/daemon/package.json", { name: "@kraka/daemon", version: "1", ...dep });
    await put(dir, "bun.lock", {
      workspaces: { "packages/daemon": dep },
      packages: {
        first: ["first@1", "", { dependencies: { shared: "1" }, ...optional }, "hash"],
        shared: ["shared@1", "", {}, "hash"],
        native: ["native@1", "", { cpu: process.arch }, "hash"],
        foreign: ["foreign@1", "", { os: "never" }, "hash"],
      },
    });
    for (const name of ["first", "shared", "native", "unused"])
      await put(dir, `node_modules/${name}/package.json`, { name, version: "1" });
    await put(dir, "node_modules/native/build/addon.node", "sample artifact");
    const { exit, reports } = await run(dir, "A1");
    expect(exit).toBe(1);
    const collect = () =>
      Bun.spawnSync(
        [process.execPath, join(import.meta.dir, "perf.ts"), "A1", "--root", dir, "--report-only"],
        { stdout: "pipe", stderr: "pipe" },
      );
    const breach = collect();
    expect(breach.exitCode).toBe(0);
    expect(JSON.parse(breach.stdout.toString())).toMatchObject({
      status: "measured",
      result: "breach",
    });
    await put(dir, "bun.lock", "invalid lock");
    const failed = collect();
    expect(failed.exitCode).toBe(1);
    expect(JSON.parse(failed.stdout.toString())).toMatchObject({ status: "failed" });
    expect(reports[0]).toMatchObject({
      status: "measured",
      result: "breach",
      actual: { closures: 1, external: 3, native: 1, platformSelected: 1 },
      observations: [
        {
          packages: [
            { id: "first@1", native: false, platformSelected: false },
            { id: "native@1", native: true, platformSelected: true },
            { id: "shared@1", native: false, platformSelected: false },
          ],
        },
      ],
    });
  });
});

test("a failed or partial test suite cannot pass the duration budget", async () => {
  await withState(async (dir) => {
    for (const [method, status] of [
      ["test", "measured"],
      ["test.skip", "failed"],
    ] as const) {
      await put(
        dir,
        "suite.test.ts",
        `import {test} from 'bun:test';test('one',()=>{});${method}('two',()=>{});`,
      );
      const result = await run(dir, "A2");
      expect(result.exit).toBe(status === "measured" ? 0 : 1);
      expect(result.reports[0]).toMatchObject({
        status,
        actual: { files: 1, fail: 0, pass: status === "measured" ? 2 : 1 },
      });
    }
    await put(
      dir,
      "suite.test.ts",
      "import {test} from 'bun:test';test('one',()=>{});test('two',()=>{throw Error('failed assertion')});",
    );
    const result = await run(dir, "A2");
    expect(result.exit).toBe(1);
    expect(result.reports[0]).toMatchObject({
      status: "failed",
      actual: { pass: 1, fail: 1 },
      observations: [{ exitCode: 1 }],
    });
  });
});

test("use midpoint median and nearest-rank p99; reject missing samples and unit mismatches", () => {
  const values = Array.from({ length: 100 }, (_, i) => ({
    series: "a",
    unit: "ms" as const,
    value: 100 - i,
  }));
  expect(summarize(values, "a", "ms", 100)).toMatchObject({
    median: 50.5,
    p99: 99,
    min: 1,
    max: 100,
    unit: "ms",
  });
  expect(() => summarize(values.slice(1), "a", "ms", 100)).toThrow();
  expect(() => summarize(values, "a", "MiB", 100)).toThrow();
});
