import { join } from "node:path";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  PairingCompletedSchema,
  PairingPendingSchema,
  PairingInviteIdSchema,
  ProjectIdSchema,
  ExecutorInstanceIdSchema,
  type Round,
  type TodoRequest,
  type ThreadId,
  type Thread,
  type ToolActivityHistoryItem,
} from "@kraka/protocol";
import { ControlStream, ControlMessageSchema, decodeFrame } from "@kraka/protocol";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import type { RouteDial } from "../../packages/client-runtime/src";
import {
  hostRelease,
  installedDirectory,
  startInstalled,
  runIdentity,
  pairingRecord,
} from "./installed";
import { installArtifact } from "../package-release";
import { beginApplication, commandId, connectDevice, type Client } from "./paired-project";
import { claudePeerControl } from "./claude-peer-control";
import { connectReplica } from "./thread-resume";
import { accepted } from "./first-send";
import { git } from "./isolated-start";
import { Journal } from "./route-network";
const framed: RouteDial = (url, receive) => {
  const ws = new WebSocket(url, "kraka.flow.v1");
  ws.binaryType = "arraybuffer";
  const utf8 = {
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b),
  };
  let flow: ControlStream | undefined,
    configured = false;
  ws.onmessage = (e) => {
    const wire = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
    if (!flow) {
      const first = decodeFrame(wire, utf8);
      if (first.lane !== "control" || first.message.kind !== "server.hello")
        throw Error("Expected framed hello");
      flow = new ControlStream(
        first.epoch,
        {
          utf8,
          now: () => performance.now(),
          write(bytes) {
            ws.send(bytes);
            return 1;
          },
        },
        () => configured,
        (m) => {
          if (m.kind === "session.configuration") configured = true;
          receive({ kind: "frame", value: m });
        },
      );
    }
    flow.input(wire);
  };
  ws.onclose = (e) => {
    flow?.close();
    receive({ kind: "closed", code: e.code });
  };
  return {
    send(frame) {
      if (!flow) throw Error("Missing control stream");
      flow.send(v.parse(ControlMessageSchema, frame));
    },
    close(code) {
      ws.close(code);
    },
  };
};
export async function installedClaude(
  artifact: Awaited<ReturnType<typeof hostRelease>>,
  executable: string,
  scenario: "command" | "interrupt" | "edit",
) {
  const dir = await mkdtemp(join(tmpdir(), "kraka-claude-installed-")),
    control = claudePeerControl();
  const clean: (() => void | Promise<void>)[] = [];
  const sockets = new Set<() => Promise<void>>();
  const disconnect = async () => {
    for (const close of [...sockets]) await close();
    sockets.clear();
  };
  let daemon: ReturnType<typeof startInstalled> | undefined;
  async function close() {
    control.releaseHeld();
    try {
      await disconnect();
    } finally {
      try {
        await daemon?.close();
      } finally {
        for (const fn of clean.reverse()) await fn();
        await control.close();
        await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      }
    }
  }
  try {
    const site = await installedDirectory(
      dir,
      await installArtifact(artifact, join(dir, "prefix")),
    );
    git(site.cwd, "init", "-b", "main");
    await writeFile(join(site.cwd, "note.txt"), "old\n");
    git(site.cwd, "add", "note.txt");
    git(site.cwd, "commit", "-m", "Initial note");
    const account = join(dir, "account");
    await mkdir(account);
    daemon = startInstalled(site, "--print-pairing");
    let pub = await daemon.ready(),
      intro = await daemon.next(pairingRecord);
    const owner = await daemon.register();
    if ((await runIdentity(site)) !== owner.identity.id) throw Error("Wrong installed environment");
    const device = await openDeviceCredentials(join(site.client, "device.sqlite"));
    clean.push(device.close);
    const mobile = await openDeviceCredentials(join(dir, "phone", "device.sqlite"));
    clean.push(mobile.close);
    const projectId = v.parse(
      ProjectIdSchema,
      new URLSearchParams(new URL(intro.url).hash.slice(1)).get("projectId"),
    );
    const app = await beginApplication(
      mobile,
      new URL(intro.url).origin,
      owner.identity,
      projectId,
      v.parse(PairingInviteIdSchema, intro.inviteId),
      [...DEFAULT_DEVICE_PERMISSIONS],
    );
    const phone = await (async () => {
      try {
        const pending = await daemon!.next(PairingPendingSchema);
        await daemon!.input("approve " + pending.requestId + " " + pending.confirmationCode);
        app.socket.send(await app.proof());
        await daemon!.next(PairingCompletedSchema);
        return app.finish(await app.socket.result());
      } finally {
        app.socket.close();
      }
    })();
    const instanceId = v.parse(ExecutorInstanceIdSchema, "fixture-claude");
    const connect = async () =>
      connectDevice(new URL(intro.url).origin, owner.identity, device, owner.principal, framed);
    let client = await connect();
    clean.push(() => client.close());
    const registration = {
      family: "claude-code" as const,
      instanceId,
      enabled: true,
      displayName: "Claude fixture",
      credential: null,
      model: { id: "claude-sonnet-4-6", options: {} },
      permission: { ceiling: "ask", selected: "ask" } as const,
      driver: {
        executable,
        configurationRoot: account,
        historyRoot: null,
        endpoint: null,
        variables: {
          KRAKA_CLAUDE_PEER: { kind: "literal" as const, value: control.url },
          KRAKA_CLAUDE_CASE: { kind: "literal" as const, value: scenario },
        },
      },
    };
    accepted(
      await client.request({
        method: "executor.configure",
        commandId: commandId(),
        payload: { expectedVersion: null, registration },
      }),
      "executorConfigured",
    );
    const refresh = accepted(
      await client.request({
        method: "executor.refresh",
        commandId: commandId(),
        payload: { projectId, instanceId },
      }),
      "executorRefreshed",
    );
    async function start(mode: "ask" | "open" = "ask") {
      return client.request({
        method: "thread.start",
        commandId: commandId(),
        payload: {
          projectId,
          instanceId,
          worktreeId: null,
          requestedMode: mode,
          content: { text: "Claude " + scenario, references: [], attachments: [] },
        },
      });
    }
    async function replica(threadId: ThreadId, deviceInfo: Pick<Client, "device" | "principal">) {
      const cache = new SqliteThreadCache(
        join(dir, crypto.randomUUID() + ".sqlite"),
        "claude-tests",
      );
      const snapshots = new Journal<{
        rounds: Round[];
        todos: TodoRequest[];
        threads: Thread[];
        tools: ToolActivityHistoryItem[];
      }>();
      const replica = await connectReplica(pub.endpoint, owner.identity, deviceInfo, cache, {
        minor: 2,
        installedDaemon: true,
        installed() {
          const values = Object.values(cache.read().rows).map((r) => r.row);
          snapshots.push({
            rounds: values.flatMap((r) => (r?.objectType === "round" ? [r.value] : [])),
            todos: values.flatMap((r) => (r?.objectType === "todoRequest" ? [r.value] : [])),
            threads: values.flatMap((r) => (r?.objectType === "thread" ? [r.value] : [])),
            tools: values.flatMap((r) =>
              r?.objectType === "timelineItem" && r.value.kind === "toolActivity" ? [r.value] : [],
            ),
          });
        },
      }).catch((e) => {
        cache.close();
        throw e;
      });
      const end = async () => {
        if (!sockets.delete(end)) return;
        try {
          await replica.close();
        } finally {
          cache.close();
        }
      };
      sockets.add(end);
      accepted(await (await replica.client.open(threadId, null)).receipt, "subscriptionOpened");
      return { rpc: replica.client.rpc.bind(replica.client), snapshots, end };
    }
    return {
      start,
      refresh,
      control,
      close,
      dir,
      site,
      owner: { device, principal: owner.principal },
      phone: { device: mobile, principal: phone.principal },
      replica,
      async restart() {
        await disconnect();
        client.close();
        await daemon!.close();
        daemon = startInstalled(site, "--print-pairing");
        pub = await daemon.ready();
        intro = await daemon.next(pairingRecord);
        client = await connect();
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
