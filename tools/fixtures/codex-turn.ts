import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import type { ExecutorTurnUpdate } from "@kraka/protocol";
import { configureLocalOwner, launchWriter, accepted, productRoot } from "./first-send";
import { connectFirstSend, fixtureActor } from "./first-send-client";
import { fixture, sampleRequest } from "./replay-process";
export type Profile = {
  kind?: "ready" | "early" | "history" | "logged-out" | "denied" | "mismatch";
  version?: string;
  absent?: boolean;
  gate?: string;
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
  return {
    rows,
    release(name: string) {
      writeFileSync(`${path}.${name}.release`, "released");
    },
    async wait(event: string) {
      const until = performance.now() + 8000;
      while (!rows().some((r) => r.event === event)) {
        if (performance.now() > until) throw new Error(`Missing peer event ${event}`);
        await Bun.sleep(3);
      }
    },
  };
}
export async function codexFixture(
  dir: string,
  profile: Profile = {},
  root = productRoot,
  hostSecret = true,
  installedBinary?: string,
) {
  const stateDir = join(dir, "state"),
    projectDir = join(dir, "project");
  mkdirSync(projectDir, { recursive: true });
  const cwd = realpathSync.native(projectDir),
    binary = installedBinary ?? (await buildPeer(dir, root)),
    ledgerPath = join(dir, "peer.jsonl"),
    ledger = peerLedger(ledgerPath);
  configureLocalOwner(stateDir, [
    "workspace.change",
    "thread.send",
    "settings.change",
    "thread.view",
  ]);
  const launch = launchWriter(stateDir, root, hostSecret ? "codex" : "codex-cli");
  try {
    const { instance } = await launch.ready();
    const updates: ExecutorTurnUpdate[] = [];
    const client = await connectFirstSend(stateDir, instance, (e) => updates.push(e));
    try {
      const project = accepted(
        (await client.send("project.register", { realPath: cwd })).receipt,
        "projectRegistered",
      ).project;
      const instanceId = "codex-test",
        credential = { ownerId: fixtureActor, namespace: instanceId, key: "marker", version: "1" };
      const variables = {
        PEER_LEDGER: { kind: "literal", value: ledgerPath },
        PEER_PROFILE: { kind: "literal", value: profile.kind ?? "ready" },
        PEER_RECORDING: { kind: "literal", value: join(root, fixture) },
        PEER_VERSION: { kind: "literal", value: profile.version ?? "0.156.0" },
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
        client,
        cwd,
        stateDir,
        project,
        updates,
        configure,
        refresh,
        registration,
        payload,
        send: () => client.send("thread.start", payload),
        async waitTerminal() {
          const end = performance.now() + 8000;
          while (!updates.some((e) => e.kind === "round.ended" || e.kind === "executor.failed")) {
            if (performance.now() > end)
              throw new Error(`Missing terminal update: ${JSON.stringify(updates)}`);
            await Bun.sleep(3);
          }
        },
        async close() {
          if (profile.gate) ledger.release(profile.gate);
          client.close();
          await launch.stop();
        },
      };
    } catch (error) {
      client.close();
      throw error;
    }
  } catch (error) {
    await launch.stop();
    throw error;
  }
}
