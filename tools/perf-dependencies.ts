import { readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import * as v from "valibot";

const edges = v.optional(v.record(v.string(), v.string()));
const selector = v.optional(v.union([v.string(), v.array(v.string())]));
const metadata = v.object({
  dependencies: edges,
  optionalDependencies: edges,
  peerDependencies: edges,
  optionalPeers: v.optional(v.array(v.string())),
  unresolved: v.optional(v.array(v.string())),
  os: selector,
  cpu: selector,
  libc: selector,
});
const manifest = v.object({
  ...metadata.entries,
  name: v.string(),
  version: v.string(),
  gypfile: v.optional(v.boolean()),
});
const lockSchema = v.object({
  workspaces: v.record(v.string(), metadata),
  packages: v.record(v.string(), v.tupleWithRest([v.string()], v.unknown())),
});
type Metadata = v.InferOutput<typeof metadata>;

function matches(value: string, selector: Metadata["os"]) {
  const items = typeof selector === "string" ? [selector] : (selector ?? []);
  return (
    !items.includes(`!${value}`) &&
    (!items.some((item) => !item.startsWith("!")) || items.includes(value))
  );
}
function onTarget(info: Metadata) {
  if (!matches(process.platform, info.os) || !matches(process.arch, info.cpu)) return false;
  if (!info.libc) return true;
  if (process.platform !== "linux") return false;
  const header = v.parse(
    v.object({ header: v.object({ glibcVersionRuntime: v.optional(v.string()) }) }),
    process.report.getReport(),
  ).header;
  return matches(header.glibcVersionRuntime ? "glibc" : "musl", info.libc);
}
async function installedDir(root: string, from: string, name: string) {
  for (let dir = from; ; dir = dirname(dir)) {
    const path = join(dir, "node_modules", name);
    if (await Bun.file(join(path, "package.json")).exists()) return realpath(path);
    if (dir === root || dir === dirname(dir)) return;
  }
}
async function hasNativeFiles(dir: string): Promise<boolean> {
  for (const file of await readdir(dir, { withFileTypes: true })) {
    if (file.name === "node_modules" || file.name === ".git") continue;
    const path = join(dir, file.name);
    if (file.isDirectory() && (await hasNativeFiles(path))) return true;
    if (!file.isFile()) continue;
    if (/\.(?:node|dll|exe|dylib)$|\.so(?:\.\d+)*$|^binding\.gyp$/i.test(file.name)) return true;
    const magic = Buffer.from(await Bun.file(path).slice(0, 4).arrayBuffer()).toString("hex");
    if (
      magic.startsWith("4d5a") ||
      [
        "7f454c46",
        "feedface",
        "feedfacf",
        "cefaedfe",
        "cffaedfe",
        "cafebabe",
        "cafebabf",
        "bebafeca",
        "bfbafeca",
      ].includes(magic)
    )
      return true;
  }
  return false;
}
export interface DependencyObservation {
  packages: { id: string; native: boolean; platformSelected: boolean }[];
  workspaces: string[];
}
export async function productionClosure(product: string, result: DependencyObservation) {
  const root = await realpath(product);
  const lock = v.parse(lockSchema, Bun.JSONC.parse(await readFile(join(root, "bun.lock"), "utf8")));
  const visited = new Set<string>();
  const external = new Set<string>();
  async function visit(dir: string, ancestry: string[], info: Metadata, workspace: boolean) {
    if (visited.has(dir)) return;
    visited.add(dir);
    const pkg = v.parse(manifest, await Bun.file(join(dir, "package.json")).json());
    if (workspace) {
      result.workspaces.push(pkg.name);
      if (
        !Bun.deepEquals(pkg.dependencies ?? {}, info.dependencies ?? {}) ||
        !Bun.deepEquals(pkg.optionalDependencies ?? {}, info.optionalDependencies ?? {}) ||
        !Bun.deepEquals(pkg.peerDependencies ?? {}, info.peerDependencies ?? {})
      )
        throw new Error(`Workspace and lock disagree for ${pkg.name}`);
    } else {
      const id = `${pkg.name}@${pkg.version}`;
      if (!external.has(id)) {
        external.add(id);
        result.packages.push({
          id,
          native: !!pkg.gypfile || (await hasNativeFiles(dir)),
          platformSelected: !!(pkg.os || pkg.cpu || pkg.libc || info.os || info.cpu || info.libc),
        });
      }
    }
    for (const name of Object.keys({
      ...info.dependencies,
      ...info.peerDependencies,
      ...info.optionalDependencies,
    })) {
      if (info.unresolved?.includes(name)) continue;
      const optional =
        Object.hasOwn(info.optionalDependencies ?? {}, name) || info.optionalPeers?.includes(name);
      const keys = [...ancestry.map((parent) => `${parent}/${name}`), name];
      const lockedKey = keys.find((k) => Object.hasOwn(lock.packages, k));
      if (!lockedKey) {
        if (optional) continue;
        throw new Error(`Missing locked dependency ${name} of ${pkg.name}`);
      }
      const row = lock.packages[lockedKey];
      if (!row) throw new Error(`Missing lock entry ${lockedKey}`);
      const [id, registryOrInfo, npmInfo] = row;
      const marker = id.indexOf("@workspace:");
      const local = marker >= 0 ? id.slice(marker + "@workspace:".length) : undefined;
      const entry =
        local === undefined
          ? v.parse(metadata, typeof registryOrInfo === "string" ? npmInfo : registryOrInfo)
          : lock.workspaces[local];
      if (!entry) throw new Error(`Missing locked workspace ${local}`);
      if (optional && !onTarget(entry)) continue;
      const child = await installedDir(root, dir, name);
      if (!child) {
        if (info.optionalPeers?.includes(name)) continue;
        throw new Error(`Missing installed dependency ${name} of ${pkg.name}`);
      }
      const installed = v.parse(manifest, await Bun.file(join(child, "package.json")).json());
      if (
        local === undefined
          ? id !== `${installed.name}@${installed.version}`
          : resolve(root, local) !== child
      )
        throw new Error(`Installed ${name} differs from lock entry ${id}`);
      await visit(child, [lockedKey, ...ancestry], entry, local !== undefined);
    }
  }
  const daemon = join(root, "packages/daemon");
  const workspace = lock.workspaces[relative(root, daemon).split(sep).join("/")];
  if (!workspace) throw new Error("Daemon is missing from bun.lock");
  await visit(daemon, ["@kraka/daemon"], workspace, true);
  result.packages.sort((a, b) => a.id.localeCompare(b.id));
  result.workspaces.sort();
}
