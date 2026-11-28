import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  CommandIdSchema,
  CommandReceiptSchema,
  type ThreadId,
  type AttemptId,
  type CommandId,
} from "@kraka/protocol";
import { InstancePublicationSchema, openReceiptReader } from "@kraka/environment";
import { connectCommands } from "../../packages/cli-client/src/first-send";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { executorPublicKey } from "../../packages/daemon/src/executor-tool-host";
import { connectReplica } from "./thread-resume";
import { startPairedProject } from "./paired-project";
import { accepted } from "./first-send";
import { seedGit, git } from "./isolated-start";
import { Journal, dispatchObservationMs } from "./route-network";
import { terminate, withState } from "./replay-process";

export const id = () => v.parse(CommandIdSchema, crypto.randomUUID());
const row = v.object({
  event: v.string(),
  attempt: v.optional(v.string()),
  id: v.optional(v.string()),
  text: v.optional(v.string()),
  kind: v.optional(v.string()),
  publication: v.optional(InstancePublicationSchema),
  result: v.optional(v.unknown()),
  receipt: v.optional(CommandReceiptSchema),
  setup: v.optional(
    v.object({
      workingDirectory: v.string(),
      model: v.object({ id: v.string(), options: v.record(v.string(), v.unknown()) }),
      permission: v.object({ selected: v.string() }),
    }),
  ),
  instanceId: v.optional(v.string()),
  taskId: v.optional(v.string()),
  transferId: v.optional(v.string()),
  parentMessageId: v.optional(v.string()),
  returnedAt: v.optional(v.number()),
  reason: v.optional(v.string()),
});
export { git as fixtureGit };

async function openScenario(dir: string, stop: string) {
  const pairing = await startPairedProject({
    stateDir: dir,
    projectId: "bootstrap",
    requests: [["thread.view"]],
  });
  const host = join(pairing.stateDir, "host"),
    repo = seedGit(dir);
  const cwd = repo.path;
  console.log(
    "Executor checkout fixture",
    repo.version,
    process.env.ImageOS ?? process.platform,
    process.env.ImageVersion ?? "",
  );
  const device = pairing.owner.device;
  const signer = { kind: "device" as const, deviceId: device.deviceId, keyId: device.keyId };
  writeFileSync(
    join(host, "local-owner.json"),
    JSON.stringify({
      principalId: pairing.owner.principal.id,
      signer,
      publicKey: executorPublicKey(device.publicKey).export({ format: "pem", type: "spki" }),
      permissions: DEFAULT_DEVICE_PERMISSIONS,
    }),
    { mode: 0o600 },
  );
  const log = new Journal<v.InferOutput<typeof row>>();
  const seen = (raw: unknown) => log.push(v.parse(row, raw));
  const peer = Bun.spawn([process.execPath, join(import.meta.dir, "executor-tool-client.ts")], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
    ipc: seen,
  });
  const until = async (
    event: string,
    fields: { id?: string; attempt?: string; text?: string } = {},
    since = 0,
  ) => {
    const entry = await log
      .until(
        (x) =>
          x.event === "error" ||
          (x.event === event &&
            Object.entries(fields).every(([k, value]) => Reflect.get(x, k) === value)),
        since,
        dispatchObservationMs,
      )
      .catch((e) => {
        throw Error(
          "Missing " +
            event +
            "; observed " +
            log.items
              .slice(-10)
              .map((x) => x.event)
              .join(", "),
          { cause: e },
        );
      });
    if (entry.event === "error") throw Error(entry.reason ?? "Fixture error");
    return entry;
  };
  async function launch(stage: string, hold: boolean) {
    const since = log.items.length;
    const child = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "executor-tools-writer.ts"),
        host,
        stage,
        hold ? "hold" : "run",
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        ipc(raw: unknown) {
          const msg = v.parse(v.object({ event: v.string() }), raw);
          if (msg.event === "tools") {
            const offer = v.parse(v.object({ attempt: v.string(), tools: v.unknown() }), raw);
            peer.send({ action: "install", ...offer });
            return;
          }
          seen(raw);
        },
      },
    );
    try {
      const ready = await until("ready", {}, since);
      if (!ready.publication) throw Error("Missing publication");
      const client = await connectCommands(
        ready.publication,
        signer,
        (value) => device.sign(value),
        () => {},
      );
      return { child, client, publication: ready.publication };
    } catch (e) {
      await terminate(child);
      throw e;
    }
  }
  const caches: SqliteThreadCache[] = [];
  const sockets: Awaited<ReturnType<typeof connectReplica>>[] = [];
  let active: Awaited<ReturnType<typeof launch>> | undefined;
  const current = () => {
    if (!active) throw Error("Writer unavailable");
    return active;
  };
  async function control(action: string, fields: object = {}) {
    const key = id(),
      since = log.items.length;
    current().child.send({ id: key, action, ...fields });
    return (await until("ack", { id: key }, since)).result;
  }
  async function disconnect() {
    for (const s of sockets.splice(0)) await s.close();
    for (const c of caches.splice(0)) c.close();
  }
  async function close() {
    try {
      await disconnect();
      if (active) {
        active.client.close();
        try {
          await control("close");
          await active.child.exited;
        } finally {
          await terminate(active.child);
        }
      }
    } finally {
      await terminate(peer);
      await pairing.close();
    }
  }
  try {
    active = await launch(stop, false);
    const project = accepted(
      (await active.client.send("project.register", { realPath: realpathSync.native(cwd) }))
        .receipt,
      "projectRegistered",
    ).project;
    await pairing.host.control("project", {
      projectId: project.id,
      threadId: "provisioned-thread",
    });
    const mobile = pairing.clients[0];
    if (!mobile) throw Error("Missing second device");
    for (const permission of ["thread.view", "owner.decide", "term.input"] as const) {
      const granted = await pairing.owner.request({
        commandId: id(),
        method: "access.grant",
        payload: {
          target: { kind: "project", projectId: project.id },
          principalId: mobile.principal.id,
          permission,
          inheritance: "children",
          modeCeiling: "ask",
        },
      });
      if (granted.kind !== "accepted") throw Error("Could not grant second device scope");
    }
    async function config(instanceId: string, model: string, version: string | null = null) {
      const r = await current().client.send("executor.configure", {
        expectedVersion: version,
        registration: {
          family: "replay",
          instanceId,
          enabled: true,
          displayName: instanceId,
          driver: {
            executable: null,
            endpoint: null,
            historyRoot: null,
            configurationRoot: null,
            variables: {},
          },
          credential: null,
          model: { id: model, options: {} },
          permission: { ceiling: "open", selected: "edits" },
        },
      });
      accepted(r.receipt, "executorConfigured");
      accepted(
        (await current().client.send("executor.refresh", { projectId: project.id, instanceId }))
          .receipt,
        "executorRefreshed",
      );
    }
    await config("primary", "model-a");
    await config("secondary", "model-b");
    const read = <T>(run: (db: ReturnType<typeof openReceiptReader>) => T) => {
      const db = openReceiptReader(host);
      try {
        return run(db);
      } finally {
        db.close(true);
      }
    };
    return {
      project,
      log,
      until,
      control,
      config,
      cwd,
      close,
      read,
      async start(text: string, isolated = false) {
        const r = accepted(
          (
            await current().client.send("thread.start", {
              projectId: project.id,
              worktreeId: isolated ? crypto.randomUUID() : null,
              content: { text, references: [], attachments: [] },
            })
          ).receipt,
          "threadStarted",
        );
        await until("installed", { attempt: r.attemptId });
        await until("start", { attempt: r.attemptId });
        return r;
      },
      async callTool(
        attempt: AttemptId,
        name: string,
        payload: unknown,
        command: CommandId = id(),
      ) {
        const since = log.items.length;
        peer.send({ action: "call", attempt, name, payload, id: command });
        const done = await until("completed", { id: command, attempt }, since);
        if (!done.receipt) throw Error("Missing receipt");
        return done.receipt;
      },
      async device(which: "owner" | "mobile", thread: ThreadId) {
        const dev = which === "owner" ? pairing.owner : mobile;
        const cache = new SqliteThreadCache(join(dir, crypto.randomUUID() + ".sqlite"), which);
        caches.push(cache);
        const socket = await connectReplica(
          current().publication.endpoint,
          pairing.identity,
          dev,
          cache,
          { minor: 1 },
        );
        sockets.push(socket);
        const sub = await socket.client.open(thread, null);
        if ((await sub.receipt).kind !== "accepted") throw Error("Denied thread read");
        await socket.until(() => socket.heads.length > 0, "installed thread");
        return socket;
      },
      async restart(hold: boolean) {
        await disconnect();
        const old = current();
        old.client.close();
        old.child.kill("SIGKILL");
        await old.child.exited;
        active = undefined;
        active = await launch("", hold);
      },
      async input(threadId: ThreadId, text: string) {
        return accepted(
          (
            await current().client.send("input.send", {
              threadId,
              content: { text, references: [], attachments: [] },
            })
          ).receipt,
          "inputScheduled",
        );
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
export type ToolScenario = Awaited<ReturnType<typeof openScenario>>;
export async function toolScenario(run: (f: ToolScenario) => Promise<void>, stop = "") {
  await withState(async (dir) => {
    const f = await openScenario(dir, stop);
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
}
