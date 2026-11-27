import { join } from "node:path";
import { writeFileSync } from "node:fs";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  SettingReadSchema,
  type SettingRead,
  type RemoteSettingTarget,
} from "@kraka/protocol";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { startPairedProject, commandId, type Client } from "./paired-project";
import { accepted, startFirstSendFixture, configureLocalOwner } from "./first-send";
import { connectReplica } from "./thread-resume";
import { seedGit } from "./isolated-start";
import { Journal } from "./route-network";

type Devices = NonNullable<Parameters<typeof startPairedProject>[0]["devices"]>;
export async function settingsHost(dir: string, name: string, devices?: Devices) {
  const pair = await startPairedProject({
    stateDir: dir,
    projectId: "project-notes",
    requests: [["thread.view"]],
    ...(devices ? { devices } : {}),
  });
  const state = join(pair.stateDir, "host");
  const events = new Journal<v.InferOutput<typeof observation>>();
  const resources: (() => void | Promise<void>)[] = [pair.close];
  async function close() {
    const errors: unknown[] = [];
    for (const dispose of resources.splice(0).reverse()) {
      try {
        await dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length) throw new AggregateError(errors, "Settings fixture cleanup failed");
  }
  try {
    const target = { kind: "environment" as const, environmentId: pair.identity.id };
    const tablet = pair.clients[0];
    if (!tablet) throw Error("Missing paired tablet");
    await pair.owner
      .request({
        method: "access.grant",
        commandId: commandId(),
        payload: {
          target,
          principalId: tablet.principal.id,
          permission: "thread.view",
          modeCeiling: "ask",
          inheritance: "children",
        },
      })
      .then((r) => accepted(r, "accessChanged"));
    const setMode = (mode: "current" | "legacy" | "oldValue" | "bare" | "locked" | "drop") =>
      writeFileSync(join(state, "setting-peer.json"), JSON.stringify(mode));
    setMode("current");
    const repo = seedGit(dir, name);
    await configureLocalOwner(state, [
      "workspace.change",
      "thread.send",
      "thread.view",
      "settings.change",
    ]);
    const launch = () =>
      startFirstSendFixture({
        stateDir: state,
        projectDirectory: repo.path,
        adapter: "replay",
        point: "settings",
        ipc(raw) {
          const event = v.parse(observation, raw);
          events.push(event);
        },
      });
    let writer = await launch();
    resources.push(() => writer.close());
    async function connect(c: Client) {
      const cache = new SqliteThreadCache(join(pair.stateDir, "views.sqlite"), c.principal.id);
      resources.push(() => cache.close());
      const connection = await connectReplica(writer.endpoint, pair.identity, c, cache, {
        minor: 2,
      });
      resources.push(() => connection.close());
      return connection.client;
    }
    const owner = await connect(pair.owner);
    const reader = await connect(tablet);
    async function startCheckout(projectId = writer.project.id) {
      const id = crypto.randomUUID();
      const result = await writer.client.send("thread.start", {
        ...writer.payload,
        projectId,
        worktreeId: id,
      });
      const thread = accepted(result.receipt, "threadStarted");
      await events.until((e) => e.event === "dispatch" && e.threadId === thread.threadId);
      await events.until((e) => e.event === "ended" && e.roundId === thread.roundId);
      return { thread, id };
    }
    return {
      pair,
      target,
      writer,
      state,
      repo,
      events,
      owner,
      reader,
      connect,
      setMode,
      startCheckout,
      devices: { owner: pair.owner.device, applicants: [tablet.device] },
      async restart() {
        await writer.close();
        writer = await launch();
        return connect(pair.owner);
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
const observation = v.variant("event", [
  v.object({ event: v.literal("ended"), roundId: v.string() }),
  v.object({ event: v.literal("dispatch"), threadId: v.string() }),
  v.object({
    event: v.literal("setting"),
    commandId: v.string(),
    method: v.string(),
    environmentId: v.string(),
    receipt: CommandReceiptSchema,
  }),
]);
export function modeQuery(target: RemoteSettingTarget, checkout: SettingRead["checkout"] = null) {
  return v.parse(SettingReadSchema, { target, field: "directoryMode", checkout });
}
