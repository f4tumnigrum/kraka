import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  ForgeRepositorySchema,
  type ForgeAccount,
  type ForgeAccountView,
  type ForgeRemote,
  type ForgeRepository,
  type ForgeUnavailableReason,
  type Project,
  type ProjectId,
  type RepositorySource,
} from "@kraka/protocol";
import type { LocalActor } from "./command-receipts";
import {
  sameForgeRepository,
  type ForgeLookupDriver,
  type ForgeScope,
  type ForgeUnavailable,
  type GitHubTokenSource,
} from "./forge";
import { remoteIdentity } from "./project-directory";
import { gitCommand, gitEnvironment } from "./git-process";

export const GITHUB_CREDENTIAL_TIMEOUT_MS = 5_000;
export const GITHUB_REQUEST_TIMEOUT_MS = 30_000;
const text = v.pipe(v.string(), v.minLength(1));
const hostConfig = v.strictObject({
  host: ForgeRepositorySchema.entries.host,
  api: text,
  apiVersion: v.optional(v.pipe(v.string(), v.regex(/^\d{4}-\d{2}-\d{2}$/)), "2026-03-10"),
  caFile: v.optional(text),
});
/** Host-local and trusted: it decides which HTTPS root receives each host's gh login. */
export const GitHubConfigSchema = v.strictObject({
  gh: v.optional(v.tupleWithRest([text], text), ["gh"]),
  hosts: v.array(hostConfig),
});
export type GitHubConfig = v.InferOutput<typeof GitHubConfigSchema>;
export const githubConfigFile = "github.json";
const publicGitHub = v.parse(GitHubConfigSchema, {
  hosts: [{ host: "github.com", api: "https://api.github.com" }],
});
/** A missing file means public GitHub. An unreadable one configures no host at all. */
export function readGitHubConfig(stateDirectory: string): GitHubConfig {
  let raw: string;
  try {
    raw = readFileSync(join(stateDirectory, githubConfigFile), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return publicGitHub;
    return { gh: ["gh"], hosts: [] };
  }
  try {
    return v.parse(GitHubConfigSchema, JSON.parse(raw));
  } catch {
    return { gh: ["gh"], hosts: [] };
  }
}

const tokenOverrides = new Set([
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
]);
/** These variables would replace the login gh stores for the selected host. */
export function ghEnvironment(inherited: NodeJS.ProcessEnv = process.env) {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(inherited))
    if (value !== undefined && !tokenOverrides.has(key.toUpperCase())) env[key] = value;
  return env;
}
type DetectedRemote = { name: ForgeRemote["name"]; url: string };
export interface GitHubHostTools extends GitHubTokenSource {
  versions(): Promise<ForgeAccountView["tools"]>;
  remote(directory: string): Promise<DetectedRemote | null>;
}
const versionText = /^[0-9][0-9A-Za-z.+-]{0,63}$/;
/** Runs gh and Git on the environment host. Their stderr is never read. */
export function localGitHubTools(gh: readonly string[], signal: AbortSignal): GitHubHostTools {
  async function run(argv: string[], env: Record<string, string>) {
    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      child = Bun.spawn(argv, {
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: GITHUB_CREDENTIAL_TIMEOUT_MS,
        killSignal: "SIGKILL",
        signal,
      });
    } catch {
      return null;
    }
    try {
      const [code, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
      return code === 0 ? out : null;
    } catch {
      return null;
    } finally {
      await child.exited;
    }
  }
  async function version(argv: string[], env: Record<string, string>, name: string) {
    const found = (await run(argv, env))?.split(/\s+/);
    const value = found?.[0] === name && found[1] === "version" ? found[2] : undefined;
    return value !== undefined && versionText.test(value) ? value : null;
  }
  return {
    async githubToken(host) {
      const token = (
        await run([...gh, "auth", "token", "--hostname", host], ghEnvironment())
      )?.trim();
      return token && /^[\x21-\x7e]{1,4096}$/.test(token) ? token : null;
    },
    async versions() {
      const [git, cli] = await Promise.all([
        version(["git", "--version"], gitEnvironment(), "git"),
        version([...gh, "--version"], ghEnvironment(), "gh"),
      ]);
      return { git, gh: cli };
    },
    async remote(directory) {
      const out = await run(
        gitCommand(directory, [
          "config",
          "--local",
          "--null",
          "--get-regexp",
          "^remote\\.(upstream|origin)\\.url$",
        ]),
        gitEnvironment(),
      );
      const urls = new Map<string, string>();
      for (const line of out?.split("\0") ?? []) {
        const at = line.indexOf("\n");
        const key = line.slice(0, at).toLowerCase();
        if (at > 0 && !urls.has(key)) urls.set(key, line.slice(at + 1));
      }
      for (const name of ["upstream", "origin"] as const) {
        const url = urls.get(`remote.${name}.url`);
        if (url) return { name, url };
      }
      return null;
    },
  };
}

/** Reads a remote URL as host, owner and name. The port and any embedded login are dropped. */
export function parseForgeRemote(remote: DetectedRemote): ForgeRemote | null {
  if (/[\\\x00-\x1f?#]/.test(remote.url) || /(?:^|\/)(?:\.{1,2}|%2e)(?:\/|$)/i.test(remote.url))
    return null;
  const identity = remoteIdentity(remote.url);
  if (!identity || !v.is(ForgeRepositorySchema.entries.host, identity.host)) return null;
  const match = /^([A-Za-z0-9][A-Za-z0-9_-]*)\/([A-Za-z0-9._-]+)$/.exec(identity.path);
  const [, owner, repository] = match ?? [];
  if (!owner || !repository || /^\.+$/.test(repository)) return null;
  return { name: remote.name, host: identity.host, owner, repository };
}

type PlatformReason = Extract<
  ForgeUnavailableReason,
  "loginExpired" | "forbidden" | "rateLimited" | "notVisible" | "unreachable" | "unexpectedResponse"
>;
export type GitHubResponse =
  | { kind: "ok"; status: number; body: unknown; next: string | null }
  | { kind: "failed"; reason: PlatformReason };
/** A path under the configured API root, or a page link GitHub returned for that same origin. */
export type GitHubRequest = (input: {
  path: string;
  method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  body?: unknown;
}) => Promise<GitHubResponse>;
type Target = { root: URL; apiVersion: string; ca: string | undefined };
const failed = (reason: PlatformReason) => ({ kind: "failed", reason }) as const;

async function send(
  target: Target,
  token: string,
  input: Parameters<GitHubRequest>[0],
  lifetime: AbortSignal,
): Promise<GitHubResponse> {
  const { root } = target;
  const method = input.method ?? "GET";
  // One deadline covers every hop and the whole body. Partial bytes do not extend it.
  const signal = AbortSignal.any([lifetime, AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)]);
  let url: URL;
  try {
    url = new URL(
      input.path.startsWith("/") ? root.href.replace(/\/$/, "") + input.path : input.path,
    );
  } catch {
    return failed("unexpectedResponse");
  }
  for (let hop = 0; hop < 5; hop++) {
    // The login for this host goes to its configured origin and nowhere else.
    if (url.origin !== root.origin || url.username || url.password)
      return failed("unexpectedResponse");
    let response: Response, body: string;
    try {
      response = await fetch(url, {
        method,
        redirect: "manual",
        signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: "Bearer " + token,
          "User-Agent": "kraka",
          "X-GitHub-Api-Version": target.apiVersion,
          ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
        ...(target.ca === undefined ? {} : { tls: { ca: target.ca } }),
      });
      body = await response.text();
    } catch {
      return failed("unreachable");
    }
    const { status, headers } = response;
    const location = headers.get("location");
    if (status >= 300 && status < 400 && location && method === "GET") {
      try {
        url = new URL(location, url);
      } catch {
        return failed("unexpectedResponse");
      }
      continue;
    }
    if (status === 401) return failed("loginExpired");
    if (
      status === 429 ||
      (status === 403 &&
        (headers.has("retry-after") || headers.get("x-ratelimit-remaining") === "0"))
    )
      return failed("rateLimited");
    if (status === 403) {
      // Secondary throttling may arrive without Retry-After or an exhausted quota.
      try {
        const error = v.safeParse(v.object({ message: v.string() }), JSON.parse(body));
        if (
          error.success &&
          /(?:secondary rate limit|rate limit exceeded)/i.test(error.output.message)
        )
          return failed("rateLimited");
      } catch {
        /* A non-JSON 403 still denies this operation. */
      }
      return failed("forbidden");
    }
    if (status === 404) return failed("notVisible");
    if (status >= 500) return failed("unreachable");
    if (status < 200 || status >= 300) return failed("unexpectedResponse");
    try {
      const next = /<([^<>]+)>\s*;\s*rel="next"/.exec(headers.get("link") ?? "")?.[1] ?? null;
      return { kind: "ok", status, body: body ? JSON.parse(body) : null, next };
    } catch {
      return failed("unexpectedResponse");
    }
  }
  return failed("unexpectedResponse");
}

const messages: Record<ForgeUnavailableReason, string> = {
  hostNotConfigured: "This host is not a GitHub host configured for the environment.",
  toolMissing: "The gh command is not available on the environment host.",
  notLoggedIn: "gh on the environment host has no login for this GitHub host.",
  loginExpired: "GitHub rejected the gh login. Sign in again on the environment host.",
  forbidden: "The GitHub account is not permitted to read this.",
  rateLimited: "GitHub is rate limiting this account.",
  notVisible: "GitHub does not show this to the logged-in account.",
  unreachable: "GitHub could not be reached or did not answer in time.",
  unexpectedResponse: "GitHub returned a response the environment does not accept.",
  rootUnavailable: "The registered project directory is no longer available.",
  noRemote: "The project directory has no upstream or origin remote.",
  unsupportedRemote: "The project's remote URL does not name a GitHub repository.",
};
const publicStatus = (reason: ForgeUnavailableReason) =>
  ({ kind: "unavailable", reason, message: messages[reason] }) as const;
const unavailable = (reason: ForgeUnavailableReason): ForgeUnavailable => ({
  kind: "unavailable",
  reason,
});
const identity = v.object({
  id: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  login: v.pipe(text, v.regex(/^[A-Za-z0-9_-]+$/)),
});

export type GitHubAccountRead<T> =
  | { kind: "completed"; value: T }
  | { kind: "repositoryChanged"; repository: ForgeRepository }
  | { kind: "notFound" }
  | ForgeUnavailable;
type Session = { account: ForgeAccount; request: GitHubRequest };
type Options = {
  config(): GitHubConfig;
  project(id: ProjectId): { project: Project; directory: string | null } | null;
  tools?: (config: GitHubConfig, signal: AbortSignal) => GitHubHostTools;
};

/** The environment's only user of the gh login. A token lives for one operation on one host. */
export class GitHubAccounts implements ForgeLookupDriver {
  readonly platform = "github";
  private readonly lifetime = new AbortController();
  private readonly active = new Set<Promise<unknown>>();
  constructor(private readonly options: Options) {}

  private track<T>(work: Promise<T>) {
    this.active.add(work);
    const done = () => this.active.delete(work);
    work.then(done, done);
    return work;
  }
  private tools(config: GitHubConfig) {
    return (this.options.tools ?? ((c, signal) => localGitHubTools(c.gh, signal)))(
      config,
      this.lifetime.signal,
    );
  }
  /** Borrow the host's login, verify who it is, run one operation and drop the token. */
  private async operate<T>(
    host: string,
    run: (session: Session) => Promise<T>,
    config = this.options.config(),
    tools = this.tools(config),
  ): Promise<T | ForgeUnavailable> {
    const entry = config.hosts.find((candidate) => candidate.host === host);
    if (!entry) return unavailable("hostNotConfigured");
    let target: Target;
    try {
      const root = new URL(entry.api);
      if (root.protocol !== "https:" || root.username || root.password || root.search || root.hash)
        throw Error("Invalid API root");
      root.pathname = root.pathname.replace(/\/+$/, "");
      const ca = entry.caFile === undefined ? undefined : readFileSync(entry.caFile, "utf8");
      target = { root, apiVersion: entry.apiVersion, ca };
    } catch {
      return unavailable("hostNotConfigured");
    }
    let token = await tools.githubToken(host);
    if (token === null)
      return unavailable((await tools.versions()).gh === null ? "toolMissing" : "notLoggedIn");
    const operation = new AbortController();
    const lifetime = AbortSignal.any([this.lifetime.signal, operation.signal]);
    const request: GitHubRequest = async (input) => {
      if (token === null) return failed("loginExpired");
      const result = await send(target, token, input, lifetime);
      if (result.kind === "failed" && result.reason === "loginExpired") token = null;
      return result;
    };
    try {
      const user = await request({ path: "/user" });
      if (user.kind === "failed") return unavailable(user.reason);
      const parsed = v.safeParse(identity, user.body);
      if (!parsed.success || (token && parsed.output.login.includes(token)))
        return unavailable("unexpectedResponse");
      const { id, login } = parsed.output;
      return await run({ account: { id: String(id), login }, request });
    } finally {
      token = null;
      operation.abort();
    }
  }
  private async resolve<T>(
    remote: ForgeRemote,
    run: (found: Session & { repository: ForgeRepository }) => Promise<T>,
  ) {
    return this.operate(remote.host, async (session) => {
      const found = await session.request({
        path: `/repos/${remote.owner}/${remote.repository}`,
      });
      if (found.kind === "failed") return unavailable(found.reason);
      const parsed = v.safeParse(v.object({ id: identity.entries.id }), found.body);
      if (!parsed.success) return unavailable("unexpectedResponse");
      const repository = {
        platform: this.platform,
        host: remote.host,
        id: String(parsed.output.id),
      } as const;
      return run({ ...session, repository });
    });
  }
  private async remote(projectId: ProjectId, tools = this.tools(this.options.config())) {
    const found = this.options.project(projectId);
    const root = found?.project.root;
    if (!found || !root) return null;
    const { directory } = found;
    const detected = directory === null ? null : await tools.remote(directory);
    const remote = detected && parseForgeRemote(detected);
    const reason =
      directory === null ? "rootUnavailable" : detected ? "unsupportedRemote" : "noRemote";
    return { root, remote, reason } as const;
  }

  account(host: string) {
    return this.track(
      this.operate(host, async ({ account }) => ({ kind: "verified", account }) as const),
    );
  }
  repository(remote: ForgeRemote) {
    return this.track(
      this.resolve(
        remote,
        async ({ account, repository }) => ({ kind: "resolved", account, repository }) as const,
      ),
    );
  }
  accountView(host: string): Promise<ForgeAccountView> {
    const config = this.options.config(),
      tools = this.tools(config);
    return this.track(
      Promise.all([
        tools.versions(),
        this.operate(
          host,
          async ({ account }) => ({ kind: "verified", account }) as const,
          config,
          tools,
        ),
      ]).then(([versions, status]) => ({
        host,
        tools: versions,
        status: status.kind === "verified" ? status : publicStatus(status.reason),
      })),
    );
  }
  /** Null when the project is not registered here. */
  repositorySource(projectId: ProjectId): Promise<RepositorySource | null> {
    return this.track(
      (async () => {
        const found = await this.remote(projectId);
        if (!found) return null;
        const { root, remote } = found;
        const status = remote
          ? await this.resolve(
              remote,
              async ({ repository }) => ({ kind: "resolved", repository }) as const,
            )
          : unavailable(found.reason);
        return {
          projectId,
          root,
          remote,
          status: status.kind === "resolved" ? status : publicStatus(status.reason),
        };
      })(),
    );
  }
  /** Runs one read under the project's verified account. The request function stops working when it returns. */
  withGitHubAccount<T>(
    scope: { actor: LocalActor } & Pick<ForgeScope, "projectId"> &
      Partial<Pick<ForgeScope, "repository">>,
    read: (context: {
      accountId: string;
      repository: ForgeRepository;
      request: GitHubRequest;
    }) => Promise<T>,
  ): Promise<GitHubAccountRead<T>> {
    return this.track(
      (async (): Promise<GitHubAccountRead<T>> => {
        const visible = scope.actor.allows("thread.view", {
          kind: "project",
          projectId: scope.projectId,
        });
        const found = visible ? await this.remote(scope.projectId) : null;
        if (!found) return { kind: "notFound" };
        if (!found.remote) return unavailable(found.reason);
        return this.resolve(found.remote, async ({ account, repository, request }) =>
          scope.repository && !sameForgeRepository(scope.repository, repository)
            ? ({ kind: "repositoryChanged", repository } as const)
            : ({
                kind: "completed",
                value: await read({ accountId: account.id, repository, request }),
              } as const),
        );
      })(),
    );
  }
  /** Cancels gh children and requests. The caller awaits what is still unwinding. */
  stop() {
    this.lifetime.abort();
    return [...this.active].map((work) =>
      work.then(
        () => {},
        () => {},
      ),
    );
  }
}
