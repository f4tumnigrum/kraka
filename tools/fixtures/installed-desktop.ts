import { cp, readFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { once } from "node:events";
import { _electron } from "playwright";
import * as v from "valibot";
import type { EnvironmentId, ThreadId } from "@kraka/protocol";
import { installedRecord } from "./handoff-host";
import { Journal, dispatchObservationMs } from "./route-network";
import { within } from "./replay-process";

export async function installDesktop(prefix: string) {
  if (process.env.CI !== "true") throw Error("Electron 只在 CI 运行");
  const require = createRequire(join(import.meta.dir, "../../packages/desktop/package.json"));
  const pkg = resolve(require.resolve("electron/package.json"), "..");
  const path = (await readFile(join(pkg, "path.txt"), "utf8")).trim();
  await cp(join(pkg, "dist"), join(prefix, "electron"), {
    recursive: true,
    verbatimSymlinks: true,
  });
  await cp(join(import.meta.dir, "../../.build/desktop"), join(prefix, "desktop"), {
    recursive: true,
  });
  await Bun.write(join(prefix, "electron-path"), path);
  const trace = await Bun.build({
    entrypoints: [join(import.meta.dir, "desktop-observations.ts")],
    target: "node",
    format: "cjs",
    outdir: prefix,
    naming: "desktop-observations.cjs",
  });
  if (!trace.success) throw new AggregateError(trace.logs, "Could not build desktop observer");
}
export async function launchInstalledDesktop(input: {
  installPrefix: string;
  profileDir: string;
  stateDir: string;
  environmentId: EnvironmentId;
  threadId: ThreadId;
}) {
  if (process.env.CI !== "true") throw Error("Electron 只在 CI 运行");
  const { installPrefix, profileDir, stateDir, environmentId, threadId } = input;
  const executable = join(
    installPrefix,
    "electron",
    (await readFile(join(installPrefix, "electron-path"), "utf8")).trim(),
  );
  await access(executable);
  const app = await _electron.launch({
    executablePath: executable,
    args: [
      "-r",
      join(installPrefix, "desktop-observations.cjs"),
      ...(process.platform === "linux" ? ["--disable-setuid-sandbox"] : []),
      "--user-data-dir=" + profileDir,
      "--state-dir=" + stateDir,
      "--environment-id=" + environmentId,
      "--thread-id=" + threadId,
      join(installPrefix, "desktop"),
    ],
    timeout: 30000,
  });
  const processHandle = app.process(),
    exit =
      processHandle.exitCode !== null
        ? Promise.resolve()
        : once(processHandle, "exit").then(() => {});
  let quitting: Promise<void> | undefined,
    viewerClosed = false;
  function quit() {
    quitting ??= (async () => {
      if (
        (!viewerClosed || process.platform === "darwin") &&
        processHandle.exitCode === null &&
        processHandle.signalCode === null
      ) {
        await app.close().catch(async (error: unknown) => {
          try {
            await within(exit, 10000, "Electron shutdown");
          } catch {
            throw error;
          }
        });
      }
      await within(exit, 10000, "Electron exit");
    })();
    return quitting;
  }
  try {
    const page = await app.firstWindow(),
      output = page.locator("output[data-installed]");
    await output.waitFor({ state: "attached", timeout: 30000 });
    const read = async () =>
      v.parse(installedRecord, JSON.parse((await output.getAttribute("data-installed")) ?? "null"));
    const first = await read();
    const main = await app.evaluate(({ app }) => ({
      browserPid: app.getAppMetrics().find((metric) => metric.type === "Browser")?.pid,
      pid: process.pid,
      electron: process.versions.electron,
      chromium: process.versions.chrome,
    }));
    if (
      main.pid !== main.browserPid ||
      (process.platform !== "win32" && main.pid !== processHandle.pid) ||
      first.environmentId !== environmentId ||
      first.threadId !== threadId ||
      main.electron !== "38.0.0" ||
      main.chromium !== "140.0.7339.41"
    )
      throw Error("Installed desktop identity mismatch");
    const records = new Journal<typeof first>();
    records.push(first);
    await page.exposeFunction("observeInstalledHead", (raw: string) =>
      records.push(v.parse(installedRecord, JSON.parse(raw))),
    );
    await page.evaluate(
      `(()=>{const o=document.querySelector("output");const notify=()=>window.observeInstalledHead(o.dataset.installed);o.addEventListener("installed",notify);return notify()})()`,
    );
    return {
      page,
      first,
      main,
      deviceId: first.deviceId,
      read,
      quit,
      records,
      methods: () =>
        app.evaluate((): string[] => Reflect.get(globalThis, "observedDesktopMethods")),
      at: (predicate: (v: typeof first) => boolean) =>
        records.until(predicate, 0, dispatchObservationMs),
      async foreignWindowDenied() {
        return app.evaluate(
          async ({ BrowserWindow }, { preload, url }) => {
            const other = new BrowserWindow({
              show: false,
              webPreferences: {
                preload,
                sandbox: true,
                contextIsolation: true,
                nodeIntegration: false,
              },
            });
            try {
              await other.loadURL(url);
              return await other.webContents.executeJavaScript(
                "window.desktop.localEnvironment({action:'status'}).then(()=>false,()=>true)",
              );
            } finally {
              other.destroy();
            }
          },
          { preload: join(installPrefix, "desktop", "preload.cjs"), url: page.url() },
        );
      },
      async closeViewer() {
        if (page.isClosed()) return;
        const closed = page.waitForEvent("close");
        await app.evaluate(({ BrowserWindow }) => {
          setImmediate(() => BrowserWindow.getAllWindows()[0]?.close());
        });
        await closed;
        viewerClosed = true;
      },
    };
  } catch (e) {
    await quit();
    throw e;
  }
}
