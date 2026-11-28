import { existsSync, readFileSync, statSync, watch, type FSWatcher } from "node:fs";
import { dirname, join, resolve } from "node:path";

function gitDirectory(path: string) {
  for (let parent = path; ; parent = dirname(parent)) {
    const dot = join(parent, ".git");
    if (existsSync(dot)) {
      if (statSync(dot).isDirectory()) return dot;
      const m = /^gitdir: (.+)\r?\n?$/.exec(readFileSync(dot, "utf8"));
      return m?.[1] ? resolve(parent, m[1]) : null;
    }
    if (dirname(parent) === parent) return null;
  }
}

/** HEAD and index can live outside a linked checkout. The TTL also covers missed filesystem events. */
export function watchGitDirectory(path: string, invalidate: () => void) {
  const watchers: FSWatcher[] = [];
  const observe = (root: string, recursive: boolean) => {
    try {
      const w = watch(root, { persistent: false, recursive }, (_, name) => {
        if (name && /^\.git[\\/](?:objects|logs|refs[\\/]kraka)(?:[\\/]|$)/.test(name)) return;
        invalidate();
      });
      w.on("error", () => {
        w.close();
        invalidate();
      });
      watchers.push(w);
    } catch {
      /* The periodic probe remains available when watching is unsupported. */
    }
  };
  observe(path, true);
  try {
    const admin = gitDirectory(path);
    if (admin) {
      if (admin !== join(path, ".git")) observe(admin, false);
      const commonFile = join(admin, "commondir");
      if (existsSync(commonFile))
        observe(join(resolve(admin, readFileSync(commonFile, "utf8").trimEnd()), "refs"), true);
    }
  } catch {
    /* Recheck physical identity when reading the next observation. */
  }
  return () => {
    for (const w of watchers) w.close();
  };
}
