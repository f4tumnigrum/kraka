import { parentPort, workerData } from "node:worker_threads";
import { waitFile } from "./file-signal";
const { path, signal }: { path: string; signal: Int32Array } = workerData;
try {
  await waitFile(path, Infinity);
  Atomics.store(signal, 0, 1);
} catch {
  Atomics.store(signal, 0, -1);
} finally {
  Atomics.notify(signal, 0);
  parentPort?.close();
}
