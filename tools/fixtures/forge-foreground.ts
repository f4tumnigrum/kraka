import { mkdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import * as v from "valibot";
import {
  githubConfigFile,
  readInstancePublication,
  InstancePublicationSchema,
} from "@kraka/environment";
import type { GitHubConfig } from "@kraka/environment";
import { startPairedProject, connectDevice, commandId, type Client } from "./paired-project";
import { accepted, productRoot } from "./first-send";
import { terminate, within } from "./replay-process";

export async function forgeForeground(root: string, config: GitHubConfig) {
  const pair = await startPairedProject({
    stateDir: root,
    projectId: "invitation-only",
    requests: [["thread.view"]],
  });
  const state = join(pair.stateDir, "host");
  const clients: Client[] = [];
  const output: string[] = [];
  let stopDaemon: (() => Promise<void>) | undefined;
  async function close() {
    for (const client of clients) client.close();
    try {
      await stopDaemon?.();
    } finally {
      await pair.close();
    }
  }
  try {
    const invited = pair.clients[0];
    if (!invited) throw Error("Missing scoped device");
    invited.close();
    pair.owner.close();
    await pair.host.stop();
    await Bun.write(join(state, githubConfigFile), JSON.stringify(config));
    const child = Bun.spawn(
      [
        process.execPath,
        join(productRoot, "packages/daemon/src/index.ts"),
        "start",
        "--state-dir",
        state,
        "--print-pairing",
      ],
      {
        cwd: root,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          KRAKA_CLIENT_DIR: join(root, "local-client"),
          GH_CONFIG_DIR: join(root, "gh"),
          GH_TOKEN: "unused-override",
          GITHUB_TOKEN: "unused-override",
          GH_ENTERPRISE_TOKEN: "unused-override",
          GITHUB_ENTERPRISE_TOKEN: "unused-override",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: join(root, "empty-git-config"),
        },
      },
    );
    const stderr = new Response(child.stderr).text();
    const lines = createInterface({ input: Readable.fromWeb(child.stdout), crlfDelay: Infinity });
    const ready = Promise.withResolvers<string>();
    const drained = (async () => {
      for await (const line of lines) {
        output.push(line);
        ready.resolve(line);
      }
      ready.reject(Error("Daemon exited before publishing its endpoint"));
    })();
    stopDaemon = async () => {
      await terminate(child);
      await drained;
      output.push(await stderr);
    };
    const record = v.parse(
      v.strictObject({ kind: v.literal("ready"), publication: InstancePublicationSchema }),
      JSON.parse(await within(ready.promise, 15000, "Foreground publication")),
    );
    const disk = await readInstancePublication(state);
    if (
      !disk ||
      !Bun.deepEquals(disk, record.publication) ||
      disk.pid !== child.pid ||
      disk.environmentId !== pair.identity.id
    )
      throw Error("Wrong foreground instance");
    const origin = new URL(disk.endpoint.replace(/^ws:/, "http:")).origin;
    async function connect(seed: Client) {
      const client = await connectDevice(origin, pair.identity, seed.device, seed.principal);
      clients.push(client);
      return client;
    }
    const owner = await connect(pair.owner),
      reader = await connect(invited);
    return {
      owner,
      reader,
      close,
      captured: () => JSON.stringify([output, ...clients.map((c) => c.traffic.items)]),
      async project(name: string, remote: string) {
        const path = join(root, name);
        await mkdir(path);
        for (const args of [["init"], ["remote", "add", "origin", remote]]) {
          const result = Bun.spawnSync(["git", "-C", path, ...args], {
            stdout: "ignore",
            stderr: "pipe",
          });
          if (result.exitCode !== 0) throw Error("Could not prepare fixture Git project");
        }
        const realPath = await realpath(path);
        const { project } = accepted(
          await owner.request({
            method: "project.register",
            commandId: commandId(),
            payload: { realPath },
          }),
          "projectRegistered",
        );
        if (project.root?.realPath !== realPath) throw Error("Wrong registered project root");
        return { ...project, root: project.root };
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
