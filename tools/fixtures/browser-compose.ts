import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { join, resolve } from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { chromium } from "playwright";
import * as v from "valibot";
import {
  EnvironmentIdentitySchema,
  ProjectIdSchema,
  PairingPendingSchema,
  PairingInviteIdSchema,
} from "@kraka/protocol";
import { within } from "./replay-process";
import { requireRoutedBrowser } from "./browser-selection";

type Options = { stateDir: string; profileDir: string };
export async function provisionBrowserNetwork({ stateDir, profileDir }: Options) {
  requireRoutedBrowser();
  await Promise.all([mkdir(stateDir, { recursive: true }), mkdir(profileDir, { recursive: true })]);
  const run = await mkdtemp(join(resolve(stateDir), "network-")),
    name = `kraka-${crypto.randomUUID()}`;
  const override = join(run, "compose.json");
  // Only the caller's disposable state and browser profile are shared with the test containers.
  await writeFile(
    override,
    JSON.stringify({
      services: {
        desktop: {
          volumes: [
            { type: "bind", source: resolve(stateDir), target: "/work/state" },
            { type: "bind", source: resolve(profileDir), target: "/work/profile" },
          ],
        },
        mobile: {
          volumes: [{ type: "bind", source: resolve(profileDir), target: "/fixture/profiles" }],
        },
      },
    }),
  );
  const compose = [
    "compose",
    "-p",
    name,
    "-f",
    join(import.meta.dir, "browser-network.compose.yml"),
    "-f",
    override,
  ];
  async function command(args: string[]) {
    const child = spawn("docker", [...compose, ...args], { stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = "";
    child.stderr.on("data", (s) => {
      diagnostic = (diagnostic + s).slice(-1000);
    });
    const [code] = await once(child, "close");
    if (code !== 0) throw Error(diagnostic);
  }
  const transports = new Set<ChildProcessWithoutNullStreams>();
  let controller: ChildProcessWithoutNullStreams | undefined;
  let closing = false;
  const pending = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  async function request(op: string) {
    const id = crypto.randomUUID();
    return within(
      new Promise<unknown>((resolve, reject) => {
        if (!controller || controller.exitCode !== null) throw Error("Browser fixture stopped");
        pending.set(id, { resolve, reject });
        controller.stdin.write(`${JSON.stringify({ id, op })}\n`);
      }),
      30000,
      op,
    ).finally(() => pending.delete(id));
  }
  const proxy = createServer((socket) => {
    const pipe = spawn("docker", [
      ...compose,
      "exec",
      "-T",
      "mobile",
      "socat",
      "STDIO",
      "TCP:127.0.0.1:9222",
    ]);
    transports.add(pipe);
    pipe.stderr.resume();
    socket.pipe(pipe.stdin);
    pipe.stdout.pipe(socket);
    pipe.stdin.on("error", () => socket.destroy());
    pipe.on("error", () => socket.destroy());
    pipe.once("close", () => {
      transports.delete(pipe);
      socket.destroy();
    });
    socket.on("error", () => pipe.kill());
    socket.once("close", () => pipe.kill());
  });
  async function close() {
    if (closing) return;
    closing = true;
    try {
      if (controller && controller.exitCode === null) {
        try {
          await request("close");
        } finally {
          controller.stdin.end();
        }
      }
    } finally {
      const closed = [...transports].map(async (child) => {
        const ended = once(child, "close");
        child.kill();
        await ended;
      });
      if (proxy.listening) await new Promise<void>((done) => proxy.close(() => done()));
      await Promise.allSettled(closed);
      try {
        await command(["down", "--volumes", "--remove-orphans"]);
      } finally {
        await rm(run, { recursive: true, force: true });
      }
    }
  }
  try {
    await command(["up", "-d", "--build", "--wait"]);
    controller = spawn("docker", [
      ...compose,
      "exec",
      "-T",
      "desktop",
      "bun",
      "tools/fixtures/browser-compose-peer.ts",
    ]);
    controller.stderr.resume();
    const ready = Promise.withResolvers<unknown>();
    const lines = createInterface({ input: controller.stdout });
    lines.on("line", (line) => {
      const msg = v.parse(
        v.object({ id: v.string(), error: v.optional(v.string()), value: v.optional(v.unknown()) }),
        JSON.parse(line),
      );
      if (msg.id === "ready") {
        if (msg.error) ready.reject(Error(msg.error));
        else ready.resolve(msg.value);
        return;
      }
      const waiter = pending.get(msg.id);
      if (msg.error) waiter?.reject(Error(msg.error));
      else waiter?.resolve(msg.value);
    });
    controller.once("close", () => {
      const e = Error("Compose browser peer exited");
      ready.reject(e);
      for (const call of pending.values()) call.reject(e);
    });
    const meta = v.parse(
      v.object({
        origin: v.string(),
        identity: EnvironmentIdentitySchema,
        projectId: ProjectIdSchema,
      }),
      await within(ready.promise, 30000, "Compose fixture startup"),
    );
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const addr = proxy.address();
    if (!addr || typeof addr === "string") throw Error("Browser tunnel failed");
    const remote = await chromium.connectOverCDP(`http://127.0.0.1:${addr.port}`);
    const context = remote.contexts()[0],
      page = context?.pages()[0];
    if (!context || !page) throw Error("Missing product page");
    return {
      origin: meta.origin,
      project: { identity: meta.identity, projectId: meta.projectId },
      page,
      context,
      pair: async () => v.parse(PairingPendingSchema, await request("pair")),
      seedInvite: async () => v.parse(PairingInviteIdSchema, await request("seed")),
      route: async () => v.parse(v.string(), await request("route")),
      lan: () => request("lan"),
      disconnect: () => request("disconnect"),
      restore: () => request("restore"),
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
