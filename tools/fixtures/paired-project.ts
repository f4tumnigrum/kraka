import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import * as v from "valibot";
import {
  DevicePrincipalSchema,
  DeviceKeySchema,
  EnvironmentIdentitySchema,
  ProjectIdSchema,
  ThreadIdSchema,
  CommandIdSchema,
  canonicalJson,
  type EnvironmentIdentity,
  type PermissionItem,
  type ProjectId,
  type PairingInviteId,
  type DevicePairingResult,
  type PairingPending,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  selectRoute,
  type RouteCommand,
  type RouteDial,
  type RouteEvent,
  type SocketEvent,
} from "../../packages/client-runtime/src";
import {
  dialRoute,
  routeClock,
  openDeviceCredentials,
  pairingDisplay,
  pairingConnection,
  type LocalDevice,
} from "../../packages/cli-client/src";
import { Journal, route } from "./route-network";
import { terminate, within } from "./replay-process";

export const commandId = () => v.parse(CommandIdSchema, crypto.randomUUID());
export const principalKey = v.object({
  principal: DevicePrincipalSchema,
  deviceKey: DeviceKeySchema,
});
export async function connectDevice(
  origin: string,
  identity: EnvironmentIdentity,
  device: LocalDevice,
  principal: v.InferOutput<typeof DevicePrincipalSchema>,
  dial: RouteDial = dialRoute,
) {
  const events = new Journal<RouteEvent>(),
    traffic = new Journal<SocketEvent>();
  const selector = selectRoute({
    expectedIdentity: identity,
    orderedRoutes: [route(identity, "local", origin)],
    activeEpoch: 1,
    clock: routeClock,
    random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
    verify: verifyP256,
    dial: (url, receive) =>
      dial(url, (e) => {
        traffic.push(e);
        receive(e);
      }),
    credentials: {
      identity,
      principal,
      signer: { kind: "device", deviceId: device.deviceId, keyId: device.keyId },
      sign: device.sign,
    },
    observe: (e) => events.push(e),
  });
  try {
    const ready = await events.until((e) => e.kind === "sender" || e.kind === "diagnostic");
    if (ready.kind !== "sender")
      throw Error(`Device authorization failed: ${JSON.stringify(ready)}`);
    return {
      device,
      principal,
      events,
      traffic,
      configuration: ready.configuration,
      close: selector.close,
      async request(input: RouteCommand) {
        const cmd = device.freeze(input),
          start = events.items.length;
        if (!(await selector.send(cmd))) throw Error("Device cannot send");
        const event = await events.until(
          (e) => e.kind === "receipt" && e.receipt.commandId === cmd.commandId,
          start,
        );
        if (event.kind !== "receipt") throw Error("Missing command receipt");
        return event.receipt;
      },
    };
  } catch (e) {
    selector.close();
    throw e;
  }
}
export type Client = Awaited<ReturnType<typeof connectDevice>>;
export interface BrowserPeerOptions {
  host: string;
  port: number;
  publicOrigin?: string;
  certificate?: string;
  privateKey?: string;
}
export async function startTestHost(dir: string, browser?: BrowserPeerOptions) {
  const events = new Journal<Record<string, unknown>>();
  const p = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "pairing-daemon.ts"),
      dir,
      ...(browser ? [JSON.stringify(browser)] : []),
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(message: unknown) {
        if (message && typeof message === "object") events.push(message as Record<string, unknown>);
      },
    },
  );
  const stderr = new Response(p.stderr).text();
  const ended = p.exited.then(async (code) => ({ event: "exit", code, error: await stderr }));
  void ended.then((e) => events.push(e));
  async function event(kind: string) {
    const e = await events.until((m) => m.event === kind || m.event === "exit");
    if (e.event === "exit") throw Error(`Fixture exited: ${e.error}`);
    return e;
  }
  async function control(op: string, payload: object = {}) {
    const id = crypto.randomUUID();
    p.send({ id, op, ...payload });
    const e = await events.until((e) => e.response === id || e.event === "exit");
    if (e.error || e.event === "exit") throw Error(String(e.error));
    return e.value;
  }
  try {
    const ready = await event("ready");
    const identity = v.parse(EnvironmentIdentitySchema, ready.identity);
    return {
      identity,
      origin: v.parse(v.string(), ready.origin),
      events,
      event,
      control,
      async stop() {
        try {
          if (p.exitCode === null && p.signalCode === null) {
            await control("stop");
            await within(p.exited, 2000, "Fixture shutdown");
          }
        } finally {
          await terminate(p);
        }
      },
    };
  } catch (e) {
    await terminate(p);
    throw e;
  }
}
export async function invite(owner: Client, projectId: ProjectId) {
  const receipt = await owner.request({
    method: "device.pairing.invite",
    commandId: commandId(),
    payload: { projectId },
  });
  if (receipt.kind !== "accepted" || receipt.result.kind !== "pairingInvited")
    throw Error("Invitation denied");
  return receipt.result.inviteId;
}
export async function pendingFor(owner: Client, projectId: ProjectId, inviteId: PairingInviteId) {
  let after: string | null = null;
  const rows: PairingPending[] = [];
  do {
    const r = await owner.request({
      method: "device.pairing.listApplications",
      commandId: commandId(),
      payload: { target: { kind: "project", projectId }, inviteId, after },
    });
    if (r.kind !== "accepted" || r.result.kind !== "applicationsListed")
      throw Error("Applications unavailable");
    rows.push(...r.result.applications);
    after = r.result.next;
  } while (after);
  return rows;
}
export async function approve(owner: Client, pending: PairingPending) {
  if (pending.target.kind !== "project") throw Error("Expected project invitation");
  const manager = (await pendingFor(owner, pending.target.projectId, pending.inviteId)).find(
    (row) => row.requestId === pending.requestId,
  );
  if (!manager || canonicalJson(pairingDisplay(manager)) !== canonicalJson(pairingDisplay(pending)))
    throw Error("Owner and applicant displays differ");
  const result = await owner.request({
    method: "device.pairing.approve",
    commandId: commandId(),
    payload: {
      requestId: manager.requestId,
      confirmationCode: manager.confirmationCode,
      permissions: manager.permissions,
    },
  });
  if (result.kind !== "accepted") throw Error(`Approval denied: ${JSON.stringify(result)}`);
}
export async function beginApplication(
  device: LocalDevice,
  origin: string,
  identity: EnvironmentIdentity,
  projectId: ProjectId,
  inviteId: PairingInviteId,
  permissions: PermissionItem[],
) {
  const record = device.prepare(identity, projectId, inviteId, permissions);
  const socket = await pairingConnection(origin, identity);
  try {
    const pending = await socket.apply(record);
    return {
      socket,
      pending,
      record,
      async proof() {
        const c = await socket.challenge();
        return socket.proof(device, record, c);
      },
      finish(result: DevicePairingResult) {
        if (result.kind !== "pairing.completed") throw Error(result.reason);
        const claimed = device.load(identity.id);
        if (claimed?.kind !== "pendingExchange") throw Error("Missing selected claim");
        return device.complete(claimed, identity, result);
      },
    };
  } catch (e) {
    socket.close();
    throw e;
  }
}
export async function startPairedProject({
  stateDir: parent,
  projectId,
  requests,
  browser,
}: {
  stateDir: string;
  projectId: string;
  browser?: BrowserPeerOptions;
  requests: readonly (readonly PermissionItem[])[];
}) {
  const project = v.parse(ProjectIdSchema, projectId);
  const threadId = v.parse(ThreadIdSchema, crypto.randomUUID());
  const cleanup: (() => void)[] = [];
  const clients: Client[] = [];
  const stateDir = await mkdtemp(join(parent, "paired-"));
  let host = await startTestHost(stateDir, browser).catch(async (error) => {
    await rm(stateDir, { recursive: true, force: true });
    throw error;
  });
  const { identity } = host;
  async function local(name: string) {
    const dir = join(stateDir, name);

    const d = await openDeviceCredentials(join(dir, "device.sqlite"));
    cleanup.push(d.close);
    return d;
  }
  async function attach(d: LocalDevice, principal: v.InferOutput<typeof DevicePrincipalSchema>) {
    const c = await connectDevice(host.origin, identity, d, principal);
    cleanup.push(c.close);
    return c;
  }
  async function close() {
    for (const f of cleanup.splice(0).reverse()) f();
    try {
      await host.stop();
    } finally {
      await rm(stateDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
    }
  }
  try {
    await host.control("project", { projectId: project, threadId });
    const device = await local("owner");
    const ownerInput = {
      deviceId: device.deviceId,
      keyId: device.keyId,
      publicKey: device.publicKey,
    };
    await host.control("atHost", { allowed: false });
    if ((await host.control("owner", ownerInput)) !== null)
      throw Error("Registration without presence");
    await host.control("atHost", { allowed: true });
    const first = v.parse(principalKey, await host.control("owner", ownerInput));
    let owner = await attach(device, first.principal);
    for (const [index, permissions] of requests.entries()) {
      const d = await local(`device-${index}`);
      const id = await invite(owner, project);
      const app = await beginApplication(d, host.origin, identity, project, id, [...permissions]);
      try {
        await approve(owner, app.pending);
        app.socket.send(await app.proof());
        const registration = app.finish(await app.socket.result());
        clients.push(await attach(d, registration.principal));
      } finally {
        app.socket.close();
      }
    }
    return {
      identity,
      stateDir,
      projectId: project,
      threadId,
      clients,
      get host() {
        return host;
      },
      get owner() {
        return owner;
      },
      local,
      attach,
      close,
      async restart() {
        owner.close();
        for (const c of clients) c.close();
        await host.stop();
        host = await startTestHost(stateDir, browser);
        if (canonicalJson(host.identity) !== canonicalJson(identity))
          throw Error("Environment identity changed");
        owner = await attach(device, first.principal);
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
