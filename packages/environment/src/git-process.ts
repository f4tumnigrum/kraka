import { measureGit } from "./capture-timing";
import { physicalDirectory } from "./project-directory";
/** Git for Windows accepts drive/UNC paths with forward slashes in config and environment values. */
export function gitPath(path: string, platform: NodeJS.Platform = process.platform) {
  if (platform !== "win32") return path;
  const normalized = path.replaceAll("\\", "/");
  if (normalized.startsWith("//?/UNC/")) return "//" + normalized.slice(8);
  if (/^\/\/\?\/[A-Za-z]:\//.test(normalized)) return normalized.slice(4);
  return normalized;
}
export function gitAlternateDirectory(path: string, platform: NodeJS.Platform = process.platform) {
  const value = gitPath(path, platform);
  return value.includes(platform === "win32" ? ";" : ":") || value.startsWith('"')
    ? JSON.stringify(value)
    : value;
}
export function gitProcessError(step: string, r: GitProcessResult) {
  return new Error(step, {
    cause: "Git exit " + String(r.exitCode) + ": " + r.stderr.toString().trim().slice(-2048),
  });
}
export function gitCommand(
  directory: string,
  args: string[],
  platform: NodeJS.Platform = process.platform,
) {
  return [
    "git",
    ...(platform === "win32" ? ["-c", "core.longpaths=true"] : []),
    "-C",
    gitPath(directory, platform),
    ...args,
  ];
}
export type GitCheckout = { gitDir: string; workTree: string };
export function gitCheckoutArgs({ gitDir, workTree }: GitCheckout) {
  return ["--git-dir=" + gitDir, "--work-tree=" + workTree];
}
export function revParseLines(stdout: Buffer): string[] {
  const text = stdout.toString();
  return process.platform === "win32"
    ? text.replace(/\r?\n$/, "").split(/\r?\n/)
    : text.replace(/\n$/, "").split("\n");
}
export function gitRepositoryIdentity(directory: string) {
  const r = runGit(directory, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  return r.exitCode === 0
    ? physicalDirectory(
        r.stdout.toString().replace(process.platform === "win32" ? /\r?\n$/ : /\n$/, ""),
      )
    : null;
}

export type GitProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

export function gitEnvironment(
  extra: Record<string, string> = {},
  platform: NodeJS.Platform = process.platform,
  inherited = process.env,
) {
  const env: Record<string, string> = {};
  const keyFor = (key: string) => (platform === "win32" ? key.toUpperCase() : key);
  for (const [key, value] of Object.entries(inherited))
    if (value !== undefined) env[keyFor(key)] = value;
  for (const key of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  ])
    delete env[key];
  Object.assign(env, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  });
  for (const [key, value] of Object.entries(extra)) env[keyFor(key)] = value;
  return env;
}

export function runGit(
  directory: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeout?: number;
    input?: Uint8Array | Bun.BunFile;
    outputFile?: Bun.BunFile;
    maxBuffer?: number;
  } = {},
): GitProcessResult {
  const result = measureGit("git", args, () =>
    Bun.spawnSync(gitCommand(directory, args), {
      stdout: options.outputFile ?? "pipe",
      stderr: "pipe",
      stdin: options.input ?? "ignore",
      maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
      env: gitEnvironment(options.env),
      timeout: options.timeout ?? 10_000,
    }),
  );
  return {
    exitCode: result.exitCode,
    stdout: Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.alloc(0),
    stderr: result.stderr,
  };
}
