// Live cases 4; required groups ["1.", "2.", "3.", "4."]
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  ProjectIdSchema,
  ExecutorInstanceIdSchema,
  type Round,
  type RoundPhase,
} from "@kraka/protocol";
import { openDeviceCredentials } from "../../packages/cli-client/src";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { acpControl } from "../fixtures/acp-control";
import {
  hostRelease,
  disposableRelease,
  startInstalled,
  pairingRecord,
  runIdentity,
} from "../fixtures/installed";
import { browserSocketFactory } from "../../packages/browser-host/src/control-socket";
import { connectDevice, commandId } from "../fixtures/paired-project";
import { connectReplica } from "../fixtures/thread-resume";
import { accepted } from "../fixtures/first-send";
let root: string, executable: string, artifact: Awaited<ReturnType<typeof hostRelease>>;
beforeAll(async () => {
  expect(Bun.version).toBe("1.4.5");
  root = await mkdtemp(join(tmpdir(), "kraka-acp-release-"));
  artifact = await hostRelease(root);
  executable = join(root, process.platform === "win32" ? "acp-peer.exe" : "acp-peer");
  const build = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "../fixtures/acp-peer.ts"),
      "--outfile",
      executable,
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  const [code, err] = await Promise.all([build.exited, new Response(build.stderr).text()]);
  if (code) throw Error(err);
}, 120000);
afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
type Site = Parameters<Parameters<typeof disposableRelease>[1]>[0];
async function openFixture(site: Site, dir: string, scenario: string) {
  const control = acpControl();
  const cleanup: (() => void | Promise<void>)[] = [];
  const daemon = startInstalled(site, "--print-pairing");
  cleanup.push(() => daemon.close());
  async function close() {
    control.drain();
    try {
      for (const clean of cleanup.reverse()) await clean();
    } finally {
      await control.close();
    }
  }
  let stage = "publication";
  try {
    const publication = await daemon.ready();
    const info = await daemon.next(pairingRecord),
      { identity, principal } = await daemon.register();
    expect(await runIdentity(site)).toBe(publication.environmentId);
    const device = await openDeviceCredentials(join(site.client, "device.sqlite"));
    cleanup.push(() => device.close());
    const url = new URL(info.url),
      projectId = v.parse(ProjectIdSchema, new URLSearchParams(url.hash.slice(1)).get("projectId"));
    const client = await connectDevice(
      url.origin,
      identity,
      device,
      principal,
      (address, receive) => {
        const socket = browserSocketFactory(address, (event) => {
          if (event.kind === "message" && typeof event.data === "string")
            receive({ kind: "frame", value: JSON.parse(event.data) });
          else if (event.kind === "close") receive({ kind: "closed", code: event.code });
        });
        return {
          send: (frame) => socket.send(JSON.stringify(frame)),
          close: (code) => socket.close(code, ""),
        };
      },
    );
    cleanup.push(() => client.close());
    const cache = new SqliteThreadCache(join(dir, "observed.sqlite"), "acp");
    cleanup.push(() => cache.close());
    const replica = await connectReplica(publication.endpoint, identity, client, cache, {
      minor: 1,
      subprotocol: "kraka.thread.v1",
    });
    cleanup.push(() => replica.close());
    const instanceId = v.parse(ExecutorInstanceIdSchema, "generic-acp");
    const registration = {
      family: "acp" as const,
      instanceId,
      displayName: "ACP",
      enabled: true,
      driver: {
        executable,
        args: [control.url, scenario],
        endpoint: null,
        configurationRoot: null,
        historyRoot: null,
        variables: {},
      },
      credential: null,
      model: null,
      permission: { ceiling: "ask" as const, selected: "ask" as const },
    };
    stage = "configure";
    accepted(
      await client.request({
        method: "executor.configure",
        commandId: commandId(),
        payload: { registration, expectedVersion: null },
      }),
      "executorConfigured",
    );
    stage = "refresh";
    const refreshed = accepted(
      await client.request({
        method: "executor.refresh",
        commandId: commandId(),
        payload: { projectId, instanceId },
      }),
      "executorRefreshed",
    );
    const prompt =
      scenario === "permission"
        ? "Run printf moss and report the result."
        : "Print the sample label with a command, then quote it back.";
    stage = "start";
    const first = accepted(
      await client.request({
        method: "thread.start",
        commandId: commandId(),
        payload: {
          projectId,
          instanceId,
          worktreeId: null,
          content: { text: prompt, references: [], attachments: [] },
        },
      }),
      "threadStarted",
    );
    stage = "subscribe";
    const sub = await replica.client.open(first.threadId, null, true);
    await sub.receipt;
    const rows = () => Object.values(cache.read().rows).flatMap((r) => (r.row ? [r.row] : []));
    const round = () =>
      rows().find((r) => r.objectType === "round" && r.value.id === first.roundId);
    async function phase(kind: RoundPhase["kind"]) {
      await replica
        .until(
          () => {
            const item = round();
            return item?.objectType === "round" && item.value.attempt.phase.kind === kind;
          },
          kind,
          12000,
        )
        .catch((e) => {
          throw Error(
            kind +
              " snapshots " +
              JSON.stringify(rows()) +
              " daemon " +
              daemon.stderrTail() +
              " " +
              e,
          );
        });
      const item = round();
      if (item?.objectType !== "round") throw Error("Missing round");
      return item.value;
    }
    return {
      control,
      close,
      first,
      rows,
      refreshed,
      phase,
      replica,
      client,
      projectId,
      registration,
      instanceId,
    };
  } catch (err) {
    const observed = control.ledger.items.map((e) => e.kind);
    await close();
    throw Error(
      stage + " (" + observed.join(",") + "): " + String(err) + " " + daemon.stderrTail(),
    );
  }
}
type Fixture = Awaited<ReturnType<typeof openFixture>>;
async function run(
  scenario: string,
  body: (f: Fixture) => Promise<void>,
  after?: (c: Fixture["control"]) => void,
) {
  await disposableRelease(artifact, async (site, dir) => {
    const f = await openFixture(site, dir, scenario);
    try {
      await body(f);
    } finally {
      await f.close();
    }
    const peers = new Set(f.control.ledger.items.map((e) => e.peer));
    for (const peer of peers) expect(f.control.count("eof", "eof", peer)).toBe(1);
    after?.(f.control);
  });
}
function ended(r: Round) {
  const phase = r.attempt.phase;
  if (phase.kind !== "finished") throw Error("Missing completed root");
  return phase;
}
test(
  "1. Policy, permission and late completion (J-1.5)",
  () =>
    run(
      "permission",
      async (f) => {
        await f.control.waitFor("permissionIssued", 91);
        const held = await f.control.waitFor("terminalHeld", 3);
        expect(f.refreshed.snapshot?.permission).toEqual({ ceiling: "ask", selected: "ask" });
        expect(f.refreshed.sessionPolicy).toEqual({
          supportedModes: ["ask"],
          enforcement: "adapter",
        });
        const handed = await f.phase("handed");
        expect(String(handed.executor?.nativeSessionId)).toBe(held.sessionId);
        expect(handed.attempt.phase).not.toHaveProperty("receipt");
        expect(handed.attempt.phase).not.toHaveProperty("root");
        await f.replica.until(
          () =>
            f.rows().some((r) => r.objectType === "todoRequest" && r.value.state.kind === "open"),
          "permission todo",
        );
        const request = f.rows().find((r) => r.objectType === "todoRequest");
        if (request?.objectType !== "todoRequest") throw Error("Missing pending approval");
        const target = { threadId: f.first.threadId, todoRequestId: request.value.id };
        const decision = {
          kind: "approval",
          choiceKey: "sample-once",
          decision: "allow",
          scope: "once",
        } as const;
        accepted(
          await f.replica.client.rpc("todo.decide", { ...target, decision }),
          "todoAnswerStored",
        );
        const reply = await f.control.waitFor("reply", 91);
        expect(reply.wire).toEqual({
          jsonrpc: "2.0",
          id: 91,
          result: { outcome: { outcome: "selected", optionId: "sample-once" } },
        });
        const answer = accepted(
          await f.replica.client.rpc("todo.readAnswer", target),
          "todoAnswerRead",
        );
        expect(answer.content).toEqual(decision);
        expect(answer.deviceId).toBe(f.client.device.deviceId);
        expect(answer.authorId).toBe(f.client.principal.id);
        expect(answer.at).toBeGreaterThan(0);
        f.control.release(3);
        const p = ended(await f.phase("finished"));
        expect(p.root.beganAt).toBeNull();
        expect(String(p.receipt?.sessionId)).toBe(held.sessionId);
        expect(p.endTimeEvidence).toEqual({
          source: "environmentObserved",
          executorEndedAt: null,
          environmentObservedAt: p.endedAt,
        });
        expect(f.rows().filter((r) => r.objectType === "round")).toHaveLength(1);
        expect(
          f
            .rows()
            .some(
              (r) =>
                r.objectType === "message" &&
                r.value.author.kind === "executor" &&
                r.value.text === "moss",
            ),
        ).toBe(true);
        expect(
          await f.client.request({
            method: "thread.start",
            commandId: commandId(),
            payload: {
              projectId: f.projectId,
              instanceId: f.instanceId,
              worktreeId: null,
              permission: "open",
              content: { text: "above ceiling", attachments: [], references: [] },
            },
          }),
        ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
      },
      (c) => expect(c.count("session/prompt", 3)).toBe(1),
    ),
  60000,
);
test(
  "2. Unavailable rollback (S-EXEC-003)",
  () =>
    run(
      "basic",
      async (f) => {
        await f.control.waitFor("terminalHeld", 3);
        f.control.release(3);
        const p = ended(await f.phase("finished"));
        expect(f.refreshed.snapshot?.matrix.rollbackRounds).toMatchObject({
          kind: "unsupported",
          reason: expect.any(String),
        });
        expect(
          await f.replica.client.rpc("checkpoint.rollbackDialogue", {
            threadId: f.first.threadId,
            roundId: f.first.roundId,
            attemptId: f.first.attemptId,
            worktreeId: null,
            nativeSessionId: p.root.sessionId,
            nativeRootTurnId: p.root.id,
            boundary: "before",
          }),
        ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
      },
      (c) => expect(c.ledger.items.filter((e) => e.kind.includes("rollback"))).toHaveLength(0),
    ),
  60000,
);
test(
  "3. Manual compact absent",
  () =>
    run(
      "basic",
      async (f) => {
        await f.control.waitFor("terminalHeld", 3);
        f.control.release(3);
        await f.phase("finished");
        expect(
          await f.replica.client.rpc("thread.compact", {
            threadId: f.first.threadId,
            instructions: null,
          }),
        ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
      },
      (c) => {
        expect(c.ledger.items.filter((e) => e.kind.includes("compact"))).toHaveLength(0);
        expect(c.count("session/prompt", 3)).toBe(1);
      },
    ),
  60000,
);
test(
  "4. Authentication failure (S-EXEC-027)",
  () =>
    run("authentication", async (f) => {
      const round = await f.phase("endedEarly");
      expect(round.attempt.phase).toMatchObject({
        reason: "failed",
        failure: {
          kind: "authentication",
          message: expect.stringMatching(/sign in.*executor settings.*CLI.*application.*retry/i),
        },
      });
      expect(JSON.stringify([f.rows(), f.replica.messages])).not.toContain(
        "private-fixture-marker-",
      );
    }),
  60000,
);
