export type GitProcessResult = {
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
};

export function gitEnvironment(extra: Record<string, string> = {}) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
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
    ...extra,
  });
  return env;
}

export function runGit(
  directory: string,
  args: string[],
  options: {
    env?: Record<string, string>;
    timeout?: number;
    input?: Uint8Array;
    maxBuffer?: number;
  } = {},
): GitProcessResult {
  const result = Bun.spawnSync(["git", "-C", directory, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: options.input ?? "ignore",
    maxBuffer: options.maxBuffer ?? 64 * 1024 * 1024,
    env: gitEnvironment(options.env),
    timeout: options.timeout ?? 10_000,
  });
  return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
}
