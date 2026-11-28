import { app, BrowserWindow, ipcMain, dialog, Notification, shell, powerMonitor } from "electron";
import { join, basename } from "node:path";
import { stat, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import * as v from "valibot";
import {
  DESKTOP_IPC,
  ActiveReleasePointerSchema,
  releaseDirectory,
  AttachmentIdSchema,
  EnvironmentIdSchema,
  ThreadIdSchema,
  RouteIdSchema,
  type Route,
} from "@kraka/protocol";
import { readDeviceSetting, type ClientPlatformCapabilities } from "@kraka/client-runtime";
import { observeNativeThread, type InstalledThread } from "@kraka/client-runtime/native-thread";
import { dispatchDesktop, type DesktopMethod } from "./bridge";
import { openDesktopProfile } from "./profile";
import { desktopInstances } from "./instance";

async function launch() {
  const environmentId = v.parse(
    EnvironmentIdSchema,
    app.commandLine.getSwitchValue("environment-id"),
  );
  const threadId = v.parse(ThreadIdSchema, app.commandLine.getSwitchValue("thread-id"));
  const appDir = app.getAppPath();
  const prefix = join(appDir, "..");
  const bin =
    process.platform === "win32"
      ? join(
          prefix,
          releaseDirectory(
            v.parse(
              ActiveReleasePointerSchema,
              JSON.parse(await readFile(join(prefix, "active.json"), "utf8")),
            ),
          ),
          "kraka.exe",
        )
      : join(prefix, "bin", "kraka");
  const stateDir = app.commandLine.getSwitchValue("state-dir");
  if (!stateDir) throw Error("Missing environment state directory");
  const instances = desktopInstances(bin, stateDir);
  const profile = await openDesktopProfile(app.getPath("userData"), environmentId, threadId);
  const routeId = v.parse(RouteIdSchema, environmentId + "-local");
  const document = pathToFileURL(join(appDir, "thread.html"));
  document.search = new URLSearchParams({ environmentId, threadId, routeId }).toString();
  const url = document.href;
  const window = new BrowserWindow({
    show: false,
    webPreferences: {
      defaultFontSize: readDeviceSetting(await profile.deviceSettings.read("fontSize")).value,
      preload: join(appDir, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  let viewer: ReturnType<typeof observeNativeThread> | undefined;
  let pending: Promise<"ready" | "unavailable"> | undefined,
    closed = false;
  let latest: InstalledThread | undefined;
  async function discoverLocalRoute() {
    const instance = await instances.read();
    if (closed || !instance || instance.environmentId !== environmentId) return "unavailable";
    const endpoint = new URL(instance.endpoint);
    if (
      endpoint.protocol !== "ws:" ||
      endpoint.hostname !== "127.0.0.1" ||
      endpoint.pathname !== "/ws"
    )
      return "unavailable";
    endpoint.protocol = "http:";
    const discovered: Route = {
      environmentId,
      id: routeId,
      kind: "local",
      endpoint: endpoint.origin,
      status: { kind: "untested" },
    };
    await profile.saveLocalRoute(discovered);
  }
  await discoverLocalRoute();
  async function connect(): Promise<"ready" | "unavailable"> {
    const route = await profile.route(routeId);
    if (!route || route.kind !== "local" || closed) return "unavailable";
    const first = Promise.withResolvers<"ready" | "unavailable">();
    viewer?.close();
    viewer = observeNativeThread({
      route,
      registration: profile.registration,
      sign: profile.sign,
      store: profile.store,
      threadId,
      snapshot(s) {
        if (s.phase === "sendable") first.resolve("ready");
        if (s.phase !== "sendable") latest = undefined;
        if (s.phase === "closed" || s.phase === "failed") first.resolve("unavailable");
      },
      installed(record) {
        latest = record;
        if (!closed) window.webContents.send("kraka:installed", record);
      },
      failed() {
        first.resolve("unavailable");
      },
    });
    return first.promise;
  }
  const bridge: NonNullable<ClientPlatformCapabilities["desktop"]> = {
    async connectRoute(input) {
      if (input.environmentId !== environmentId || input.routeId !== routeId) return "unavailable";
      if (viewer?.snapshot().phase === "sendable") return "ready";
      pending ??= connect().finally(() => {
        pending = undefined;
      });
      return pending;
    },
    async focusThread(input) {
      if (
        closed ||
        input.environmentId !== environmentId ||
        input.threadId !== threadId ||
        !latest ||
        !viewer?.current()
      )
        throw Error("Thread unavailable");
      window.show();
      window.focus();
      return { kind: "done" };
    },
    async localEnvironment({ action }) {
      const outcome = await instances.action(action);
      if (action === "start" && outcome === "running") await discoverLocalRoute();
      return outcome;
    },
    async showNotification({ title, body, reminder }) {
      const key = reminder.key,
        obj = key.object;
      if (
        !latest ||
        !viewer?.current() ||
        key.environmentId !== environmentId ||
        key.threadId !== threadId ||
        key.ownerId !== profile.registration.principal.id ||
        key.databaseGeneration !== latest.head.databaseGeneration ||
        !latest.rows.some((r) =>
          obj.kind === "request"
            ? r.objectType === "todoRequest" &&
              r.value.id === obj.requestId &&
              r.value.body.kind === reminder.kind
            : r.objectType === "round" &&
              r.value.id === obj.roundId &&
              r.value.attempt.attemptId === obj.attemptId,
        )
      )
        throw Error("Unknown notification target");
      const claim = await profile.reminders.claim(reminder, window.isFocused() ? key : null);
      if (claim.present) {
        const notification = new Notification({ title, body });
        notification.once("show", () => {
          if (!closed) void profile.reminders.update(key, "confirmed");
        });
        notification.show();
      }
      return { kind: "done" };
    },
    async chooseAttachment() {
      const choice = await dialog.showOpenDialog(window, { properties: ["openFile"] });
      const path = choice.filePaths[0];
      if (choice.canceled || !path) return null;
      const file = await stat(path);
      if (!file.isFile()) throw Error("Expected an attachment file");
      const id = v.parse(AttachmentIdSchema, crypto.randomUUID());
      await profile.state.commit([
        { key: "attachment/" + id, value: new TextEncoder().encode(path) },
      ]);
      return { id, name: basename(path), byteLength: file.size };
    },
    async openProjectDirectory(input) {
      const project = latest?.rows.find(
        (row) => row.objectType === "project" && row.value.id === input.projectId,
      );
      if (
        !viewer?.current() ||
        input.environmentId !== environmentId ||
        project?.objectType !== "project" ||
        project.value.environmentId !== environmentId ||
        !project.value.root
      )
        throw Error("Local project directory unavailable");
      const error = await shell.openPath(project.value.root.realPath);
      if (error) throw Error("Could not open project directory");
      return { kind: "done" };
    },
    async openExternalLink({ url }) {
      const target = new URL(url);
      if (target.username || target.password || !["https:", "http:"].includes(target.protocol))
        throw Error("Invalid external URL");
      await shell.openExternal(target.href);
      return { kind: "done" };
    },
    async forwardDevelopmentPort() {
      return { kind: "unavailable", reason: "unsupported" };
    },
    async stopDevelopmentPortMapping() {
      return { kind: "done" };
    },
  };
  for (const method of Object.keys(DESKTOP_IPC) as DesktopMethod[])
    ipcMain.handle("kraka:" + method, (event, input: unknown) =>
      dispatchDesktop(
        method,
        event,
        closed || window.isDestroyed()
          ? null
          : {
              contents: window.webContents,
              mainFrame: window.webContents.mainFrame,
              url,
            },
        input,
        bridge,
      ),
    );
  app.once("before-quit", (event) => {
    event.preventDefault();
    void instances.close().finally(() => app.quit());
  });
  const foreground = () => viewer?.foreground();
  powerMonitor.on("resume", foreground);
  window.on("focus", foreground);
  window.on("closed", () => {
    closed = true;
    viewer?.close();
    profile.close();
    powerMonitor.off("resume", foreground);
    for (const method of Object.keys(DESKTOP_IPC)) ipcMain.removeHandler("kraka:" + method);
  });
  await window.loadURL(url);
  window.show();
}
const userData = app.commandLine.getSwitchValue("user-data-dir");
if (userData) app.setPath("userData", userData);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
void app
  .whenReady()
  .then(launch)
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Desktop launch failed");
    app.exit(1);
  });
