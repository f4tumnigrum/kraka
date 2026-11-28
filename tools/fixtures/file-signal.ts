import { existsSync, watch } from "node:fs";
import { dirname } from "node:path";
export async function waitForFileChange(
  path: string,
  ready: () => boolean,
  ms: number,
  label: string,
) {
  const signal = Promise.withResolvers<void>();
  const check = () => {
    try {
      if (ready()) signal.resolve();
    } catch (error) {
      signal.reject(error);
    }
  };
  const watcher = watch(dirname(path), check);
  watcher.on("error", signal.reject);
  const timer = Number.isFinite(ms) ? setTimeout(() => signal.reject(Error(label)), ms) : undefined;
  try {
    check();
    await signal.promise;
  } finally {
    clearTimeout(timer);
    watcher.close();
  }
}
export function waitFile(path: string, ms = 8000) {
  return waitForFileChange(path, () => existsSync(path), ms, "Missing " + path);
}
