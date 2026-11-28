import { randomInt } from "node:crypto";
import { createInterface } from "node:readline";
import { clientDeviceFile, openDeviceCredentials, ownedDirectory } from "@kraka/cli-client";
import { createPairingInvite, openStore, openWriter, registerProject } from "@kraka/environment";
import {
  CommandIdSchema,
  DEFAULT_DEVICE_PERMISSIONS,
  HostInstanceIdSchema,
  PairingCompletedSchema,
  PairingInviteIdSchema,
  PrincipalIdSchema,
  type PairingPending,
} from "@kraka/protocol";
import * as v from "valibot";
import { forgeReadOnControl } from "./signed-requests/forge";
import { openAccessHost } from "./access";
import { browserAssets, preflight } from "./browser-listener";
import { ExecutorInstances } from "./executor-instances";
import { threadWork } from "./thread-work";
import { listenIdentity } from "./identity";

const emit = (record: unknown) => process.stdout.write(JSON.stringify(record) + "\n");
const commandId = () => v.parse(CommandIdSchema, crypto.randomUUID());
async function openBrowser(url: string) {
  const custom = process.env.KRAKA_URL_OPENER;
  const argv = custom
    ? [custom, url]
    : process.platform === "win32"
      ? ["rundll32.exe", "url.dll,FileProtocolHandler", url]
      : [process.platform === "darwin" ? "open" : "xdg-open", url];
  const child = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  if ((await child.exited) !== 0) throw Error("Browser opener failed");
}

export async function startForeground(stateDir: string, mode: "print" | "open") {
  const dir = await ownedDirectory(stateDir);
  const lock = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 10_000,
  );
  if (lock.kind === "unconfirmed") throw Error(lock.reason);
  if (lock.kind === "existingInstance") {
    emit({ kind: lock.kind, publication: lock.instance });
    return;
  }
  const cleanup: (() => void | Promise<void>)[] = [() => lock.close()];
  let closing: Promise<void> | undefined;
  function close() {
    closing ??= (async () => {
      process.off("SIGINT", close);
      process.off("SIGTERM", close);
      const errors: unknown[] = [];
      for (const stop of cleanup.reverse()) {
        try {
          await stop();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length) throw new AggregateError(errors, "Foreground shutdown failed");
    })();
    return closing;
  }
  try {
    const store = openStore(lock.lease);
    cleanup.push(() => store.db.close(true));
    const executors = new ExecutorInstances(store);
    cleanup.push(() => executors.close());
    const local = await openDeviceCredentials(clientDeviceFile());
    cleanup.push(local.close);
    let confirmed = false;
    const host = await openAccessHost(dir, {
      present: async () => confirmed && process.stdin.isTTY === true,
      approve: async (d) =>
        confirmed &&
        d.operation === "bootstrap" &&
        d.deviceId === local.deviceId &&
        d.keyId === local.keyId &&
        d.publicKey === local.publicKey,
    });
    cleanup.push(host.close);
    const environmentId = host.identity.id;
    const localProject = registerProject({
      environmentId,
      transaction: store,
      realPath: process.cwd(),
      commandId: commandId(),
      actor: {
        id: v.parse(PrincipalIdSchema, "foreground-host"),
        environmentId,
        allows: (right) => right === "workspace.change",
      },
    });
    if (localProject.kind !== "accepted" || localProject.result.kind !== "projectRegistered")
      throw Error("Cannot register foreground working directory");
    const projectId = localProject.result.project.id;
    host.store.provisionProject(projectId);
    const target = { kind: "project", projectId } as const;
    const invite = createPairingInvite(
      environmentId,
      v.parse(PairingInviteIdSchema, crypto.randomUUID()),
      target,
      Date.now(),
    );
    if ((await host.store.create(invite)) !== "created")
      throw Error("Cannot create pairing invitation");
    const work = threadWork(
      store,
      host,
      {
        get id() {
          const owner = host.store.registeredOwner(local.deviceId, local.keyId, local.publicKey);
          if (!owner) throw Error("Foreground owner unavailable");
          return owner.principal.id;
        },
      },
      executors,
      null,
    );
    cleanup.push(() => work.close());
    host.port.openThread = (nonce) => work.openThread(nonce, true);
    host.port.login = (device, req, session) =>
      executors.track(
        executors.login.command(
          {
            actor: {
              id: device.principal.id,
              environmentId,
              allows: (right, target) => !!host.store.ceiling(device.principal.id, target, right),
            },
            transaction: store,
            commandId: req.commandId,
          },
          session,
          req,
        ),
      );
    const access = host.port.request;
    host.port.request = (device, r) => {
      const actor = {
        id: device.principal.id,
        environmentId,
        allows: (
          right: Parameters<typeof host.store.ceiling>[2],
          object: Parameters<typeof host.store.ceiling>[1],
        ) => Boolean(host.store.ceiling(device.principal.id, object, right)),
      };
      const context = { actor, transaction: store, commandId: r.commandId };
      if (r.method === "thread.start") return work.startAndSchedule(actor, r);
      if (r.method === "executor.configure") return executors.configure(context, r.payload);
      if (r.method === "executor.refresh")
        return executors.refresh(context, r.payload, device.principal.ownerId);
      if (r.method === "forge.account" || r.method === "project.repositorySource")
        return forgeReadOnControl(r, store, actor);
      if (r.method === "project.register") {
        const response = registerProject({ ...context, environmentId, ...r.payload });
        if (response.kind === "accepted" && response.result.kind === "projectRegistered")
          host.store.provisionProject(response.result.project.id);
        return response;
      }
      return access(device, r);
    };
    const applications = new Map<string, PairingPending>();
    host.port.pairingPending = (p) => {
      if (p.inviteId === invite.inviteId) {
        applications.set(p.requestId, p);
        emit(p);
      }
    };
    host.port.beforePairingReply = async (result) => {
      if (
        mode === "print" &&
        result.kind === "pairing.completed" &&
        applications.has(result.requestId)
      )
        emit(v.parse(PairingCompletedSchema, result));
    };
    host.port.confirmInstance = (nonce) =>
      nonce.endsWith("?idle") && (executors.active.size || work.busy) ? null : lock.confirm(nonce);
    host.port.configuration.description = {
      owner: "foreground",
      platform:
        process.platform === "win32"
          ? "windows"
          : process.platform === "darwin"
            ? "macos"
            : "linux",
      onLastWindow: "keepRunning",
      onDesktopQuit: "keepRunning",
    };
    const browserOrigin = process.env.KRAKA_BROWSER_ORIGIN;
    if (browserOrigin && !browserOrigin.startsWith("https://"))
      throw Error("Private browser route requires HTTPS");
    const listener = listenIdentity(host.port, 0, browserOrigin ? [browserOrigin] : [], undefined, {
      binding: await preflight({ host: "127.0.0.1", port: 0 }),
      asset: await browserAssets(),
    });
    cleanup.push(listener.close);
    const endpoint = new URL("/ws", listener.origin);
    endpoint.protocol = "ws:";
    work.recover(() => emit({ kind: "ready", publication: lock.publish(endpoint.href) }));
    process.once("SIGINT", close);
    process.once("SIGTERM", close);
    const url = new URL("/", listener.origin);
    url.hash = new URLSearchParams({
      environmentId,
      publicKey: host.identity.publicKey,
      keyVersion: String(host.identity.keyVersion),
      projectId,
      inviteId: invite.inviteId,
    }).toString();
    if (mode === "print")
      emit({
        kind: "pairing",
        environmentId,
        inviteId: invite.inviteId,
        url: url.href,
        expiresAt: invite.expiresAt,
      });
    const ownerCode = randomInt(1_000_000).toString().padStart(6, "0");
    const existing = local.load(environmentId);
    if (existing?.kind !== "registered")
      emit({
        kind: "owner.confirm",
        identity: host.identity,
        deviceId: local.deviceId,
        keyId: local.keyId,
        publicKey: local.publicKey,
        confirmationCode: ownerCode,
        command: "register " + ownerCode,
      });
    const input = createInterface({ input: process.stdin, terminal: false });
    let handling = Promise.resolve();
    cleanup.push(
      () => handling,
      () => input.close(),
    );
    async function handle(line: string) {
      if (line === "register " + ownerCode && !confirmed) {
        confirmed = true;
        try {
          if (!host.store.registeredOwner(local.deviceId, local.keyId, local.publicKey))
            await host.trusted.confirm({
              kind: "bootstrap",
              environment: host.identity,
              deviceId: local.deviceId,
              keyId: local.keyId,
              publicKey: local.publicKey,
            });
          const device = host.store.registeredOwner(local.deviceId, local.keyId, local.publicKey);
          if (!device) throw Error("Owner confirmation denied");
          local.saveHostRegistration({
            kind: "registered",
            identity: host.identity,
            deviceId: local.deviceId,
            keyId: local.keyId,
            publicKey: local.publicKey,
            target,
            ...device,
            permissions: [...DEFAULT_DEVICE_PERMISSIONS],
          });
          emit({ kind: "owner.registered", environmentId, principal: device.principal });
        } finally {
          confirmed = false;
        }
        return;
      }
      const [action, id, code, ...rest] = line.trim().split(/\s+/);
      const pending = id ? applications.get(id) : undefined;
      const owner = host.store.registeredOwner(local.deviceId, local.keyId, local.publicKey);
      if (
        action !== "approve" ||
        rest.length ||
        !pending ||
        pending.confirmationCode !== code ||
        !owner
      )
        throw Error("Expected approve REQUEST_ID CONFIRMATION_CODE from the registered owner");
      const receipt = host.store.command(owner, {
        method: "device.pairing.approve",
        commandId: commandId(),
        payload: {
          requestId: pending.requestId,
          confirmationCode: code,
          permissions: pending.permissions,
        },
      });
      if (receipt.kind !== "accepted") throw Error("Pairing approval denied");
    }
    input.on("line", (line) => {
      handling = handling
        .then(() => handle(line))
        .catch(() => {
          process.stderr.write("Host confirmation denied. Check the device, request and code.\n");
        });
    });
    if (mode === "open") {
      try {
        await openBrowser(url.href);
        emit({ kind: "browser.opened" });
      } catch {
        process.exitCode = 1;
        process.stderr.write(
          "Browser could not open. The foreground daemon is running at " + listener.origin + "\n",
        );
      }
    }
  } catch (e) {
    await close();
    throw e;
  }
}
