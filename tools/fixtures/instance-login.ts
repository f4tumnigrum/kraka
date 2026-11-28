import { join } from "node:path";
import { mkdir, realpath } from "node:fs/promises";
import * as v from "valibot";
import { expect } from "bun:test";
import { InstancePublicationSchema, confirmWriter, openReceiptReader } from "@kraka/environment";
import { ProjectIdSchema, type CommandId } from "@kraka/protocol";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { loginPeer, type Profile } from "./login-control";
import { accepted, configureLocalOwner } from "./first-send";
import { commandId, startPairedProject, type Client } from "./paired-project";
import { Journal } from "./route-network";
import { connectReplica } from "./thread-resume";
import { terminate, within, withState } from "./replay-process";

const notice = v.variant("kind", [
  v.object({
    kind: v.literal("ready"),
    instance: InstancePublicationSchema,
    projectId: ProjectIdSchema,
  }),
  v.object({
    kind: v.literal("callbackHandled"),
    flowId: v.string(),
    disposition: v.picklist(["applied", "discarded"]),
  }),
  v.object({ kind: v.literal("advanced"), at: v.number() }),
]);
async function create(dir: string) {
  const cleanup: (() => unknown)[] = [];
  const publicValues: unknown[] = [];
  const deviceValues: { A: unknown[]; B: unknown[] } = { A: [], B: [] };
  const logs: string[] = [];
  const peer = await loginPeer(dir);
  cleanup.push(() => peer.close());
  async function close() {
    peer.release();
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse())
      try {
        await dispose();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, "Login fixture shutdown failed");
  }
  try {
    const pair = await startPairedProject({
      stateDir: dir,
      projectId: "initial-project",
      requests: [["thread.view"]],
    });
    cleanup.push(() => pair.close());
    const tablet = pair.clients[0];
    if (!tablet) throw Error("Expected paired device");
    const target = { kind: "environment" as const, environmentId: pair.identity.id };
    for (const permission of ["settings.change", "thread.view"] as const)
      accepted(
        await pair.owner.request({
          method: "access.grant",
          commandId: commandId(),
          payload: {
            target,
            principalId: tablet.principal.id,
            permission,
            modeCeiling: "ask",
            inheritance: "children",
          },
        }),
        "accessChanged",
      );
    const state = await realpath(join(pair.stateDir, "host")),
      project = join(dir, "project");
    await mkdir(project);
    await configureLocalOwner(state);
    const out = join(dir, "login-daemon.mjs");
    const build = Bun.spawn(
      [
        process.execPath,
        "build",
        "--target=bun",
        join(import.meta.dir, "instance-login-daemon.ts"),
        "--outfile",
        out,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
    if (code !== 0) throw Error(err);
    const events = new Journal<v.InferOutput<typeof notice>>();
    const child = Bun.spawn(
      [
        process.execPath,
        out,
        state,
        await realpath(project),
        pair.owner.principal.id,
        String(peer.now()),
      ],
      {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        ipc(raw: unknown) {
          events.push(v.parse(notice, raw));
        },
      },
    );
    const output = Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    cleanup.push(async () => {
      try {
        if (child.exitCode === null) {
          child.send({ kind: "close" });
          await within(child.exited, 15000, "Writer exit");
        }
      } finally {
        await terminate(child);
        logs.push(...(await output));
      }
      if (child.exitCode !== 0) throw Error("Writer exited abnormally");
      const db = openReceiptReader(state);
      try {
        for (const table of ["receipts", "instance_logins", "executor_registrations"])
          publicValues.push(...db.query("SELECT * FROM " + table).all());
      } finally {
        db.close(true);
      }
    });
    const ready = await Promise.race([
      events.until((e) => e.kind === "ready"),
      child.exited.then(async () => {
        throw Error("Fixture exited: " + (await output).join(" "));
      }),
    ]);
    if (ready.kind !== "ready") throw Error("Missing endpoint");
    expect((await confirmWriter(state, performance.now() + 5000))?.instanceId).toBe(
      ready.instance.instanceId,
    );
    async function connect(device: Client, id: Profile) {
      const cache = new SqliteThreadCache(join(dir, id + "-cache.sqlite"), device.principal.id);
      cleanup.push(() => cache.close());
      const s = await connectReplica(
        ready.kind === "ready" ? ready.instance.endpoint : "",
        pair.identity,
        device,
        cache,
        { received: (_kind, message) => deviceValues[id].push(message) },
      );
      cleanup.push(() => s.close());
      return s.client;
    }
    const clients = { A: await connect(pair.owner, "A"), B: await connect(tablet, "B") };
    const regs = {
      A: (await peer.profile("A", pair.owner.principal.id)).reg,
      B: (await peer.profile("B", pair.owner.principal.id)).reg,
    };
    const projectId = ready.projectId;
    async function configure(id: Profile) {
      const { version, ...registration } = regs[id];
      return accepted(
        await clients.A.rpc("executor.configure", { expectedVersion: null, registration }),
        "executorConfigured",
      );
    }
    async function refresh(id: Profile, reader: Profile = id, force = false) {
      const summary = accepted(
        await clients[reader].rpc("executor.refresh", { instanceId: id, projectId, force }),
        "executorRefreshed",
      );
      publicValues.push(summary);
      return summary;
    }
    async function start(id: Profile, flowId = commandId()) {
      return accepted(
        await clients[id].rpc(
          "executor.startLogin",
          {
            instanceId: id,
            interaction: id === "A" ? "browser" : "deviceCode",
            expectedAccount: id + "@example.invalid",
          },
          flowId,
        ),
        "instanceLogin",
      );
    }
    async function read(instanceId: Profile, flowId: CommandId, device: Profile = instanceId) {
      return accepted(
        await clients[device].rpc("executor.readLogin", { instanceId, flowId }),
        "instanceLogin",
      );
    }
    async function cancel(instanceId: Profile, flowId: CommandId, device: Profile = instanceId) {
      return clients[device].rpc("executor.cancelLogin", { instanceId, flowId });
    }
    return {
      peer,
      clients,
      projectId,
      configure,
      refresh,
      start,
      read,
      cancel,
      close,
      async advance(to: number) {
        peer.setTime(to);
        child.send({ kind: "advance", to });
        await events.until((e) => e.kind === "advanced" && e.at === to);
      },
      handled: (flowId: string, disposition: "applied" | "discarded") =>
        events.until(
          (e) =>
            e.kind === "callbackHandled" && e.flowId === flowId && e.disposition === disposition,
        ),
      inspect() {
        for (const id of ["A", "B"] as const) {
          const other = id === "A" ? "B" : "A";
          for (const value of [publicValues, logs, peer.ledger.items, deviceValues[other]])
            expect(JSON.stringify(value)).not.toMatch(
              new RegExp("fixture-secret-" + id + "|fixture-private-" + id + "|fixture-code-" + id),
            );
          expect(JSON.stringify(deviceValues[id])).not.toContain("fixture-secret-" + id);
        }
        expect(
          peer.ledger.items.some(
            (e) => e.method === "spawn.mismatch" || e.method === "cancel.mismatch",
          ),
        ).toBe(false);
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export async function loginCase(run: (f: Awaited<ReturnType<typeof create>>) => Promise<void>) {
  await withState(async (dir) => {
    const fixture = await create(dir);
    try {
      await run(fixture);
    } finally {
      await fixture.close();
    }
    fixture.inspect();
  });
}
