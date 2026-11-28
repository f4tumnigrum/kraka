import { lstatSync, mkdirSync, readdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { gitPath } from "./git-process";
import { hashId } from "./worktree-storage";

export function writerGitPaths(stateDirectory: string, environmentId: string) {
  const state = realpathSync.native(stateDirectory);
  return {
    writer: `w-${hashId(JSON.stringify([environmentId, state]))}`,
    diffScratch: join(state, "diff-scratch"),
    captureScratch: join(state, "capture-scratch"),
    state,
  };
}
export function privateDirectory(path: string) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory()) throw Error("Invalid private Git directory");
}
export function privateHooks(state: string) {
  const path = join(state, "git-empty-hooks");
  privateDirectory(path);
  if (readdirSync(path).length) throw Error("Private Git hooks directory must be empty");
  return "core.hooksPath=" + gitPath(path);
}
