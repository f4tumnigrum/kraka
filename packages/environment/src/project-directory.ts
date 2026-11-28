import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { ProjectRootSchema, RepositoryIdentitySchema } from "@kraka/protocol";
import * as v from "valibot";

export function physicalDirectory(path: string) {
  if (!isAbsolute(path)) return null;
  try {
    const realPath = realpathSync.native(path);
    const stat = statSync(realPath, { bigint: true });
    return stat.isDirectory()
      ? { realPath, identity: [stat.dev, stat.ino, stat.birthtimeNs].join("/") }
      : null;
  } catch {
    return null;
  }
}
function git(path: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", "-C", path, ...args], {
    stdout: "pipe",
    stderr: "ignore",
    timeout: 2000,
  });
  return result.exitCode === 0 ? result.stdout.toString().trim() : null;
}
export function remoteIdentity(remote: string | null) {
  if (!remote) return null;
  try {
    const normalized = remote.includes("://")
      ? remote
      : remote.replace(/^(?:[^@/:]+@)?([^/:]+):(.+)$/, "ssh://$1/$2");
    const url = new URL(normalized);
    if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return null;
    const parsed = v.safeParse(RepositoryIdentitySchema, {
      host: url.hostname.toLowerCase(),
      port: url.port ? Number(url.port) : null,
      path: url.pathname.replace(/^\/+|\.git\/?$|\/$/g, ""),
    });
    return parsed.success ? parsed.output : null;
  } catch {
    return null;
  }
}
export function projectRoot(realPath: string) {
  const checkout = git(realPath, "rev-parse", "--show-toplevel");
  const origin = checkout
    ? remoteIdentity(git(realPath, "config", "--local", "--get", "remote.origin.url"))
    : null;
  const upstream = checkout
    ? remoteIdentity(git(realPath, "config", "--local", "--get", "remote.upstream.url"))
    : null;
  return v.parse(ProjectRootSchema, {
    directoryId: crypto.randomUUID(),
    generation: "1",
    realPath,
    repository: upstream ?? origin,
    origin,
    relativeToCheckout: checkout ? relative(checkout, realPath).split(sep).join("/") : null,
  });
}
