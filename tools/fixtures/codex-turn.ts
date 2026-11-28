import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { Journal } from "./route-network";
import type { ExecutorTurnUpdate } from "@kraka/protocol";
import { configureLocalOwner, launchWriter, accepted, productRoot } from "./first-send";
import { connectFirstSend, fixtureActor } from "./first-send-client";
import { fixture, sampleRequest } from "./replay-process";
export type Profile = {
  kind?: "ready" | "early" | "history" | "logged-out" | "denied" | "mismatch";
  version?: string;
  absent?: boolean;
  gate?: string;
  control?: string;
  capture?: (raw: unknown) => void;
  historyDirectory?: string;
};
export async function buildPeer(dir: string, root = productRoot) {
  const exe = join(dir, process.platform === "win32" ? "codex-peer.exe" : "codex-peer");
  if (!existsSync(exe)) {
    const p = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        join(root, "tools/fixtures/codex-peer.ts"),
        "--outfile",
        exe,
      ],
      { cwd: root, stdout: "ignore", stderr: "pipe" },
    );
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    if (code !== 0) throw new Error(err);
  }
  return exe;
}
const rowSchema = v.looseObject({
  handle: v.number(),
  event: v.string(),
  id: v.nullable(v.number()),
});
export function peerLedger(path: string) {
  const rows = () =>
    existsSync(path)
      ? readFileSync(path, "utf8")
          .split("\n")
          .slice(0, -1)
          .map((s) => v.parse(rowSchema, JSON.parse(s)))
      : [];
  return { rows };
}
export function peerSignals(hold?: string) {
  const events = new Journal<string>();
  const released = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const event = new URL(req.url).pathname.slice(1);
      events.push(event);
      if (event === hold) await released.promise;
      return new Response(null, { status: 204 });
    },
  });
  return {
    url: server.url.href,
    async wait(event: string) {
      try {
        await events.until((name) => name === event, 0, 8000);
      } catch (cause) {
        throw Error(`Missing peer event ${event}`, { cause });
      }
    },
    release: () => released.resolve(),
    async close() {
      released.resolve();
      await server.stop(true);
    },
  };
}
export async function codexFixture(
  dir: string,
  profile: Profile = {},
  root = productRoot,
  hostSecret = true,
  installedBinary?: string,
  stateDir = join(dir, "state"),
  onUpdate?: (event: ExecutorTurnUpdate) => void,
) {
  const projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const cwd = realpathSync.native(projectDir),
    binary = installedBinary ?? (await buildPeer(dir, root)),
    ledgerPath = join(dir, "peer.jsonl"),
    ledger = peerLedger(ledgerPath);
  await configureLocalOwner(stateDir, [
    "workspace.change",
    "thread.send",
    "settings.change",
    "thread.view",
  ]);
  const launch = launchWriter(
    stateDir,
    root,
    hostSecret ? "codex" : "codex-cli",
    undefined,
    profile.capture,
  );
  let signals: ReturnType<typeof peerSignals> | undefined;
  try {
    if (profile.gate) signals = peerSignals(`gate.${profile.gate}`);
    const { publication: instance } = await launch.ready();
    const events = new Journal<ExecutorTurnUpdate>();
    const updates = events.items;
    const client = await connectFirstSend(stateDir, instance, (e) => {
      events.push(e);
      onUpdate?.(e);
    });
    try {
      const project = accepted(
        (await client.send("project.register", { realPath: cwd })).receipt,
        "projectRegistered",
      ).project;
      const instanceId = "codex-test",
        credential = { ownerId: fixtureActor, namespace: instanceId, key: "marker", version: "1" };
      const variables = {
        ...(profile.historyDirectory
          ? { PEER_HISTORY_DIRECTORY: { kind: "literal", value: profile.historyDirectory } }
          : {}),
        ...(profile.control ? { PEER_CONTROL: { kind: "literal", value: profile.control } } : {}),
        PEER_LEDGER: { kind: "literal", value: ledgerPath },
        PEER_PROFILE: { kind: "literal", value: profile.kind ?? "ready" },
        PEER_RECORDING: { kind: "literal", value: join(root, fixture) },
        PEER_VERSION: { kind: "literal", value: profile.version ?? "0.156.0" },
        ...(signals && { PEER_SIGNALS: { kind: "literal", value: signals.url } }),
        PEER_GATE: { kind: "literal", value: profile.gate ?? "" },
        SYNTHETIC_CODEX: { kind: "secret", binding: credential },
      };
      const registration = {
        family: "codex",
        instanceId,
        displayName: "Synthetic Codex",
        enabled: true,
        credential,
        driver: {
          executable: profile.absent ? `${binary}-absent` : binary,
          endpoint: null,
          configurationRoot: null,
          historyRoot: null,
          variables,
        },
        model: { id: "gpt-5.4", options: { effort: "medium" } },
        permission: { selected: "ask", ceiling: "edits" },
      };
      const configure = (expectedVersion: string | null = null, r = registration) =>
        client.send("executor.configure", {
          registration: hostSecret
            ? r
            : {
                ...r,
                credential: null,
                driver: {
                  ...r.driver,
                  variables: Object.fromEntries(
                    Object.entries(r.driver.variables).filter(
                      ([, value]) => value.kind === "literal",
                    ),
                  ),
                },
              },
          expectedVersion,
        });
      const refresh = () => client.send("executor.refresh", { projectId: project.id, instanceId });
      const payload = { projectId: project.id, worktreeId: null, content: sampleRequest.input };
      return {
        ...launch,
        instance,
        ledger,
        signals,
        client,
        cwd,
        stateDir,
        project,
        updates,
        events,
        configure,
        refresh,
        registration,
        payload,
        send: () => client.send("thread.start", payload),
        async waitTerminal() {
          await events.untilDispatch(
            (e) => e.kind === "round.ended" || e.kind === "executor.failed",
          );
        },
        async close() {
          signals?.release();
          client.close();
          try {
            await launch.stop();
          } finally {
            await signals?.close();
          }
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  } catch (error) {
    try {
      await launch.stop();
    } finally {
      await signals?.close();
    }
    throw error;
  }
}
