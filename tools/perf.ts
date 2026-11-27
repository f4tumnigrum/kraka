import { ownerProvisioner, sampleOwnerPair } from "./measure-owner-launch";
import { readdir } from "node:fs/promises";
import { arch, cpus, hostname, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { entry, withState } from "./fixtures/replay-process";
import { command, identity, replayCounts, sampleReplay } from "./measure-replay";
import {
  budgetValue,
  exceedsBudget,
  catalog,
  type Metric,
  metricIds,
  type ProbeSpec,
  type Unit,
} from "./perf-catalog";
import { type DependencyObservation, productionClosure } from "./perf-dependencies";

type Role = "baseline" | "candidate";
type Counts = Record<string, number>;
interface Sample {
  series: string;
  unit: Unit;
  value: number;
}
type Revision = Awaited<ReturnType<typeof identity>>;
function hostInfo() {
  const os = platform(),
    cpu = cpus()[0]?.model,
    memoryBytes = totalmem();
  const osVersion = os === "darwin" ? command(["sw_vers", "-productVersion"]).trim() : release();
  return {
    os,
    osVersion,
    hostId: new Bun.CryptoHasher("sha256").update(hostname()).digest("hex"),
    kernel: release(),
    architecture: arch(),
    cpu,
    memoryBytes,
    bun: Bun.version,
    reference:
      cpu === "Apple M2" &&
      memoryBytes === 16 * 1024 ** 3 &&
      os === "darwin" &&
      osVersion === "26.2"
        ? "Apple M2 / 16 GiB / macOS 26.2"
        : "host observation; historical reference machine unavailable",
  };
}
export interface ReportBase extends ProbeSpec {
  metric: Metric;
  variant?: "access.listSessions";
  role: Role;
  platform: ReturnType<typeof hostInfo>;
  revision: string | null;
  digest?: string;
  probeRevision: Revision | null;
  expected: Counts;
  actual: Counts;
  samples: Sample[];
  observations: unknown[];
}
type Summary = ReturnType<typeof summarize>;
export type ProbeReport = ReportBase &
  (
    | { status: "measured"; summary: Summary[]; result: "pass" | "breach" | "observation" }
    | { status: "unavailable"; reason: string; comparison: "not comparable" }
    | { status: "failed"; error: string }
  );
export function summarize(samples: Sample[], series: string, unit: Unit, expected: number) {
  const selected = samples.filter((s) => s.series === series);
  if (!expected || selected.length !== expected)
    throw new Error(`Expected ${expected} ${series} samples, got ${selected.length}`);
  if (selected.some((s) => s.unit !== unit || !Number.isFinite(s.value)))
    throw new Error(`Invalid ${series} observation, expected finite ${unit}`);
  const values = selected.map((s) => s.value).sort((a, b) => a - b);
  const at = (i: number) => values[i] ?? NaN;
  return {
    series,
    unit,
    count: values.length,
    median: (at(Math.floor((expected - 1) / 2)) + at(Math.floor(expected / 2))) / 2,
    p99: at(Math.ceil(expected * 0.99) - 1),
    min: at(0),
    max: at(expected - 1),
  };
}
function measured(base: ReportBase, seriesCounts: Counts, observationOnly = false): ProbeReport {
  for (const [name, expected] of Object.entries(base.expected)) {
    if (base.actual[name] !== expected)
      throw new Error(`Expected ${name}=${expected}, got ${base.actual[name]}`);
  }
  const summary = base.thresholds.map((t) =>
    summarize(base.samples, t.series, t.unit, seriesCounts[t.series] ?? 0),
  );
  const breach = base.thresholds.some((t, i) => {
    const s = summary[i];
    if (!s) throw new Error(`Missing summary for ${t.series}`);
    return exceedsBudget(t, budgetValue(t, s));
  });
  return {
    ...base,
    status: "measured",
    summary,
    result: observationOnly ? "observation" : breach ? "breach" : "pass",
  };
}
function unavailable(base: ReportBase, reason: string): ProbeReport {
  if (base.samples.length) throw new Error("Cannot mark a sampled workload unavailable");
  return { ...base, status: "unavailable", reason, comparison: "not comparable" };
}
async function measureReplay(
  base: ReportBase,
  root: string,
  allowStub: boolean,
  nextBlock: () => Promise<void>,
) {
  const idle = base.metric === "P2";
  const count = idle ? 10 : 20;
  const counts = replayCounts();
  base.expected = Object.fromEntries(Object.keys(counts).map((key) => [key, count]));
  base.actual = counts;
  if (idle && !["darwin", "linux", "win32"].includes(process.platform))
    return unavailable(base, `No current process footprint method for ${process.platform}`);
  async function sample(dir: string, kind: "empty" | "reused" | "idle") {
    const reading = await sampleReplay(root, dir, kind, allowStub, counts);
    if (reading.kind === "stub") return false;
    base.observations.push(reading);
    base.samples.push(
      reading.kind === "idle"
        ? { series: "idle", unit: "MiB", value: reading.mib }
        : {
            series: reading.kind === "empty" ? "fresh" : "reused",
            unit: "ms",
            value: reading.elapsedMs,
          },
    );
    return true;
  }
  for (let i = 0; i < 10; i++) {
    const available = await withState(async (dir) => {
      if (idle) return sample(dir, "idle");
      return (await sample(dir, "empty")) && (await sample(dir, "reused"));
    });
    if (!available)
      return unavailable(base, "Known baseline stub exited 0 before ready; replay.run is absent");
    await nextBlock();
  }
  return measured(
    base,
    idle ? { idle: 10 } : { fresh: 10, reused: 10 },
    idle && process.platform !== "darwin",
  );
}
async function suiteFiles(dir: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (file.name === "node_modules" || file.name.startsWith(".")) continue;
    const name = prefix + file.name;
    if (file.isDirectory()) files.push(...(await suiteFiles(join(dir, file.name), `${name}/`)));
    else if (file.isFile() && /[._](test|spec)\.[cm]?[jt]sx?$/.test(name)) files.push(name);
  }
  return files.sort();
}
async function measureSuite(base: ReportBase, root: string) {
  const expectedFiles = await suiteFiles(root);
  const hash = new Bun.CryptoHasher("sha256");
  for (const file of expectedFiles)
    hash
      .update(file)
      .update("\0")
      .update(await Bun.file(join(root, file)).arrayBuffer())
      .update("\0");
  const suiteDigest = hash.digest("hex");
  base.expected = { suites: 1, files: expectedFiles.length, fail: 0 };
  const start = performance.now();
  const child = Bun.spawn([process.execPath, "test"], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, FORCE_COLOR: "0", NO_COLOR: "1" },
  });
  const [out, err, ended] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited.then((exit) => ({ exit, elapsed: performance.now() - start })),
  ]);
  const log = `${out}\n${err}`.replace(/^::group::/gm, "");
  const count = (name: string) => {
    const hits = [...log.matchAll(new RegExp(`^\\s*(\\d+) ${name}\\s*$`, "gm"))];
    return hits.length === 1 ? Number(hits[0]?.[1]) : undefined;
  };
  const summary = /^Ran (\d+) tests? across (\d+) files?\b/gm.exec(log);
  const pass = count("pass"),
    fail = count("fail"),
    skip = count("skip") ?? 0,
    todo = count("todo") ?? 0;
  const files = [...log.matchAll(/^([^\r\n]+\.[cm]?[jt]sx?):\r?$/gm)]
    .map((m) => (m[1] ?? "").replaceAll("\\", "/"))
    .sort();
  base.actual = {
    suites: 1,
    files: files.length,
    skip,
    todo,
    ...(pass === undefined ? {} : { pass }),
    ...(fail === undefined ? {} : { fail }),
  };
  base.observations.push({
    exitCode: ended.exit,
    signal: child.signalCode,
    files,
    suiteDigest,
    elapsedMs: ended.elapsed,
  });
  base.samples.push({ series: "suite", unit: "ms", value: ended.elapsed });
  if (
    ended.exit !== 0 ||
    !pass ||
    fail !== 0 ||
    skip ||
    todo ||
    pass !== Number(summary?.[1]) ||
    files.length !== Number(summary?.[2]) ||
    !Bun.deepEquals(files, expectedFiles)
  )
    throw new Error(`Incomplete or failed bun test (exit ${ended.exit}): ${log.slice(-3000)}`);
  return measured(base, { suite: 1 });
}
async function measureClosure(base: ReportBase, root: string) {
  const result: DependencyObservation = { packages: [], workspaces: [] };
  base.expected = { closures: 1 };
  base.actual = { closures: 0 };
  base.observations.push(result);
  await productionClosure(root, result);
  base.actual = {
    closures: 1,
    workspaces: result.workspaces.length,
    external: result.packages.length,
    native: result.packages.filter((p) => p.native).length,
    platformSelected: result.packages.filter((p) => p.platformSelected).length,
  };
  base.samples.push(
    { series: "external", unit: "packages", value: result.packages.length },
    {
      series: "native",
      unit: "packages",
      value: result.packages.filter((p) => p.native || p.platformSelected).length,
    },
  );
  return measured(base, { external: 1, native: 1 });
}
async function checkCommandSurface(root: string) {
  // Probe the executable in the selected root before declaring an endpoint unavailable.
  return withState(async (dir) => {
    const r = Bun.spawnSync(
      [process.execPath, join(root, entry), "probe-unknown-command", "--state-dir", dir],
      {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
        timeout: 10000,
      },
    );
    const diagnostic = r.stderr.toString().trim();
    if (
      r.exitCode !== 1 ||
      r.signalCode ||
      r.stdout.length ||
      ![
        "Unknown command, expected replay",
        "Unknown command, expected replay or start",
        "Unknown command, expected replay or daemon",
        "Unknown command, expected replay, start or daemon",
        "Unknown command, expected replay or access",
        "Unknown command, expected replay, start or access",
        "Unknown command, expected replay, start, access or daemon",
      ].includes(diagnostic)
    )
      throw new Error(`Cannot confirm command surface (exit ${r.exitCode}): ${r.stderr}`);
    return diagnostic;
  });
}
export function parseSelection(args: string[]) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      "report-only": { type: "boolean" },
      root: { type: "string", multiple: true },
      "baseline-root": { type: "string", multiple: true },
    },
    allowPositionals: true,
    strict: true,
  });
  const roots = [...(values.root ?? []), ...(values["baseline-root"] ?? [])];
  if (roots.length > 1 || roots.some((r) => !r || r.startsWith("--")))
    throw new Error("Choose one --root DIR or --baseline-root DIR");
  for (const id of positionals)
    if (!Object.hasOwn(catalog, id)) throw new Error(`Unknown metric ${id}`);
  return {
    ...(values["report-only"] ? { reportOnly: true } : {}),
    metrics: metricIds.filter((id) => !positionals.length || positionals.includes(id)),
    root: resolve(roots[0] ?? "."),
    role: values["baseline-root"] ? ("baseline" as const) : ("candidate" as const),
  };
}
export type Workload = Pick<ReportBase, "metric" | "variant">;

export function budgetWorkloads(metrics: readonly Metric[]): Workload[] {
  for (const id of metrics)
    if (!Object.hasOwn(catalog, id)) throw new Error(`Unknown metric ${id}`);
  return metricIds
    .filter((m) => !metrics.length || metrics.includes(m))
    .flatMap((metric): Workload[] =>
      metric === "P1" ? [{ metric, variant: "access.listSessions" }, { metric }] : [{ metric }],
    );
}

export async function prepareBudget(root: string, role: Role) {
  root = resolve(root);
  const platform = hostInfo();
  const probe = resolve(import.meta.dir, "..");
  let productRevision: Revision | undefined,
    probeRevision: Revision | null = null,
    setupError: unknown;
  try {
    probeRevision = await identity(probe, false);
    productRevision = root === probe ? probeRevision : await identity(root, role === "baseline");
  } catch (error) {
    setupError = error;
  }
  let stub = false,
    replayAttempted = false;
  const inputEndpoint = await Bun.file(
    join(root, "packages/environment/src/input-command.ts"),
  ).exists();
  let capability: Promise<string> | undefined;
  const commandSurface = () => (capability ??= checkCommandSurface(root));
  const durable = await Bun.file(join(root, "packages/daemon/src/first-send.ts")).exists();
  return async (
    workload: Workload,
    nextBlock: () => Promise<void> = async () => {},
  ): Promise<ProbeReport> => {
    const { metric, variant } = workload;
    const base: ReportBase = {
      ...workload,
      role,
      platform,
      revision: null,
      ...productRevision,
      probeRevision,
      ...catalog[metric],
      expected: {},
      actual: {},
      samples: [],
      observations: [],
    };
    let report: ProbeReport;
    try {
      if (setupError) throw setupError;
      if (metric === "A1") report = await measureClosure(base, root);
      else if (metric === "A2") report = await measureSuite(base, root);
      else if (variant === "access.listSessions") {
        base.workload =
          "Ten provisioned fresh/reused directory pairs, daemon spawn through first signed access.listSessions acceptance, existing OS cache";
        base.endpoint = "access serve with a registered device";
        base.expected = { launches: 20, accepted: 20, joined: 20 };
        base.actual = { launches: 0, accepted: 0, joined: 0 };
        if (
          role === "baseline" &&
          !(await Bun.file(join(root, ownerProvisioner)).exists()) &&
          !(await commandSurface()).includes("access")
        )
          report = unavailable(
            base,
            "Parent has no protected owner enrollment and signed access.listSessions launch",
          );
        else {
          for (let i = 0; i < 10; i++) {
            await withState((dir) =>
              sampleOwnerPair(root, dir, base.actual, (series, value, commandId) => {
                base.samples.push({ series, value, unit: "ms" });
                base.observations.push({
                  pair: i + 1,
                  series,
                  commandId,
                  method: "access.listSessions",
                  elapsedMs: value,
                });
              }),
            );
            await nextBlock();
          }
          report = measured(base, { fresh: 10, reused: 10 });
        }
      } else if (
        durable &&
        role === "baseline" &&
        (metric === "P1" || metric === "P2") &&
        !(await Bun.file(join(root, "packages/daemon/src/codex-instances.ts")).exists())
      ) {
        const daemon = await Bun.file(join(root, "packages/daemon/src/index.ts")).text();
        if (!daemon.includes("createReplayAdapter") || daemon.includes("createCodexAdapter"))
          throw new Error("Unrecognized daemon adapter selection");
        report = unavailable(
          base,
          "Parent first-send writer only supports the replay adapter; missing Codex stdio profile",
        );
      } else if (
        durable &&
        (metric === "P1" ||
          metric === "P2" ||
          metric === "P7" ||
          metric === "P9" ||
          (metric === "P10" && inputEndpoint))
      ) {
        const { measureFirstSend } = await import("./measure-first-send");
        const series = await measureFirstSend(base, root, metric, nextBlock);
        report = measured(base, series, metric === "P2" && process.platform !== "darwin");
      } else if (metric === "P1" || metric === "P2") {
        if (stub) {
          base.actual = replayCounts();
          base.expected = Object.fromEntries(Object.keys(base.actual).map((key) => [key, 10]));
          report = unavailable(base, "Known baseline stub has no replay.run");
        } else {
          const allowStub = role === "baseline" && !replayAttempted;
          replayAttempted = true;
          report = await measureReplay(base, root, allowStub, nextBlock);
        }
        if (report.status === "unavailable" && report.reason.startsWith("Known baseline stub"))
          stub = true;
      } else if (
        metric === "P11" &&
        (await Bun.file(join(root, "packages/daemon/src/flow-socket.ts")).exists())
      ) {
        const { sampleTransfers } = await import("./stream-flow-bench");
        base.expected = {
          uploads: 10,
          downloads: 10,
          uploadBytes: 200_000_000,
          downloadBytes: 200_000_000,
        };
        base.actual = { uploads: 0, downloads: 0, uploadBytes: 0, downloadBytes: 0 };
        const series = { upload: 0, download: 0 };
        for await (const trial of sampleTransfers(root)) {
          const { direction, bytes, receiptsMs } = trial;
          base.observations.push(trial);
          base.actual[`${direction}s`] = (base.actual[`${direction}s`] ?? 0) + 1;
          base.actual[`${direction}Bytes`] = (base.actual[`${direction}Bytes`] ?? 0) + bytes;
          series[direction] += receiptsMs.length;
          for (const value of receiptsMs)
            base.samples.push({ series: direction, unit: "ms", value });
          await nextBlock();
        }
        report = measured(base, series);
      } else {
        base.expected = { capabilityChecks: 1, workloadSamples: 0 };
        base.actual = { capabilityChecks: 0, workloadSamples: 0 };
        if (metric === "P11" && role === "candidate")
          throw new Error("Missing required flow-controlled transfer endpoint");
        if (metric === "P8") {
          if (
            !(await Bun.file(join(root, "packages/daemon/package.json")).exists()) ||
            (await Bun.file(join(root, "tools/package-release.ts")).exists())
          )
            throw new Error("Cannot confirm absence of the daemon release packager");
        } else if (!stub) {
          const diagnostic = await commandSurface();
          if (metric === "P11" && diagnostic.includes("daemon"))
            throw new Error("Cannot confirm absence of the flow-controlled endpoint");
        }
        base.actual.capabilityChecks = 1;
        report = unavailable(base, `Missing ${base.endpoint}`);
      }
    } catch (error) {
      report = { ...base, status: "failed", error: String(error) };
    }
    return report;
  };
}
export async function runBudget({
  metrics,
  root,
  role,
  reportOnly = false,
  writeReport,
}: {
  metrics: readonly Metric[];
  root: string;
  role: Role;
  reportOnly?: boolean;
  writeReport: (r: ProbeReport) => void;
}): Promise<number> {
  const workloads = budgetWorkloads(metrics);
  const measure = await prepareBudget(root, role);
  let exit = 0;
  for (const workload of workloads) {
    const report = await measure(workload);
    writeReport(report);
    if (
      report.status === "failed" ||
      (!reportOnly && report.status === "measured" && report.result === "breach")
    )
      exit = 1;
  }
  return exit;
}
if (import.meta.main) {
  try {
    process.exitCode = await runBudget({
      ...parseSelection(process.argv.slice(2)),
      writeReport: (r) => process.stdout.write(`${JSON.stringify(r)}\n`),
    });
  } catch (error) {
    console.error(String(error));
    process.exitCode = 1;
  }
}
