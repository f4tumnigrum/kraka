// Live cases 5; required groups []
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { openReceiptReader, readRound } from "@kraka/environment";
import { finishedCapture } from "../fixtures/first-send-client";
import { accepted } from "../fixtures/first-send";
import { codexFixture, buildPeer, peerSignals, type Profile } from "../fixtures/codex-turn";
import { fixture, terminate, withState } from "../fixtures/replay-process";
import { productRoot } from "../fixtures/first-send";
export async function startCodexPeer({
  recording,
  profile,
  cwd,
}: {
  recording: string;
  profile: Profile;
  cwd: string;
}) {
  const binary = await buildPeer(cwd),
    ledgerPath = join(cwd, "direct.jsonl");
  const signals = peerSignals();
  const child = Bun.spawn([binary, "app-server"], {
    cwd,
    env: {
      PEER_RECORDING: recording,
      PEER_LEDGER: ledgerPath,
      PEER_PROFILE: profile.kind ?? "ready",
      PEER_SIGNALS: signals.url,
    },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  return {
    child,
    wait: signals.wait,
    async close() {
      try {
        await terminate(child);
      } finally {
        await signals.close();
      }
    },
  };
}
type F = Awaited<ReturnType<typeof codexFixture>>;
async function scenario(profile: Profile, run: (f: F) => Promise<void>) {
  await withState(async (dir) => {
    const f = await codexFixture(dir, profile);
    try {
      await run(f);
    } finally {
      await f.close();
    }
  });
}
async function inspectStoppedWriter(
  f: F,
  inspect: (db: ReturnType<typeof openReceiptReader>) => void,
) {
  await f.close();
  expect(existsSync(join(f.stateDir, "instance.json"))).toBe(false);
  const db = openReceiptReader(f.stateDir);
  try {
    inspect(db);
  } finally {
    db.close(true);
  }
}
async function configure(f: F) {
  const r = accepted((await f.configure()).receipt, "executorConfigured");
  expect(String(r.version)).toBe("1");
  return r;
}
async function refresh(f: F) {
  return accepted((await f.refresh()).receipt, "executorRefreshed");
}
test("1. signed configuration persists scoped references and refresh redacts variables", async () => {
  await scenario({}, async (f) => {
    const bad = structuredClone(f.registration);
    bad.driver.variables.SYNTHETIC_CODEX.binding.key = "missing";
    expect((await f.configure(null, bad)).receipt).toMatchObject({
      kind: "rejected",
      failure: { kind: "notFound" },
    });
    await configure(f);
    const r = await refresh(f);
    expect(r).toMatchObject({
      configurationVersion: "1",
      snapshot: {
        family: "codex",
        instanceId: "codex-test",
        permission: { selected: "ask", ceiling: "edits" },
      },
    });
    expect(r.variables).toContainEqual({ name: "SYNTHETIC_CODEX", kind: "secret" });
    expect(JSON.stringify(r)).not.toContain("fake-private-marker");
    expect(f.ledger.rows()).toContainEqual(
      expect.objectContaining({ event: "spawn", present: true, cwd: f.cwd }),
    );
    await inspectStoppedWriter(f, (db) => {
      const row = db.query<{ data: string }, []>("SELECT data FROM executor_registrations").get();
      expect(JSON.parse(row?.data ?? "null")).toMatchObject({
        version: "1",
        credential: f.registration.credential,
      });
    });
  });
}, 60000);
test("2. installation, compatibility and existing-login probe; interactive login belongs to S41", async () => {
  await withState(async (cwd) => {
    const peer = await startCodexPeer({ recording: join(productRoot, fixture), cwd, profile: {} });
    try {
      peer.child.stdin.write(`${JSON.stringify({ id: 1, method: "initialize", params: {} })}\n`);
      await peer.child.stdin.flush();
      await peer.wait("initialize");
      peer.child.stdin.write('{"method":"initialized"}\n');
      await peer.child.stdin.flush();
      await peer.wait("initialized");
    } finally {
      await peer.close();
    }
  });
  for (const [profile, installed, authenticated, advisory] of [
    [{ absent: true }, "no", "unknown", null],
    [{ version: "0.148.9" }, "yes", "unknown", "broken"],
    [{ kind: "logged-out" }, "yes", "no", null],
    [{ version: "0.152.0" }, "yes", "yes", "unsupported"],
    [{}, "yes", "yes", null],
  ] as const)
    await scenario(profile, async (f) => {
      await configure(f);
      const r = await refresh(f);
      expect(r.readiness.installed.state).toBe(installed);
      expect(r.readiness.authenticated.state).toBe(authenticated);
      expect(r.compatibilityAdvisory).toBe(advisory);
      expect(r.binaryVersion).toBe(
        "absent" in profile ? null : "version" in profile ? profile.version : "0.156.0",
      );
      const rows = f.ledger.rows();
      const handles = [...new Set(rows.map((row) => row.handle))].sort((a, b) => a - b);
      const exited = [
        ...new Set(rows.filter((row) => row.event === "exit").map((row) => row.handle)),
      ].sort((a, b) => a - b);
      expect(exited).toEqual(handles);
      expect(rows.filter((x) => x.event === "account/login/start")).toHaveLength(0);
      if (advisory === "broken") expect(rows.filter((x) => x.event === "version")).toHaveLength(2);
      if (authenticated === "yes") expect(rows.some((x) => x.event === "account/read")).toBe(true);
    });
}, 90000);
test("3. paged catalog survives model refusal; replacement discards an in-flight old probe", async () => {
  await scenario({ kind: "denied" }, async (f) => {
    await configure(f);
    const r = await refresh(f);
    expect(r.models?.models.map((m) => m.slug)).toEqual(["gpt-5.4", "other"]);
    expect(r.models?.models[0]).toMatchObject({
      isDefault: true,
      options: { effort: { kind: "enum", values: ["medium"] } },
    });
    expect(
      f.ledger
        .rows()
        .filter((r) => r.event === "model/list")
        .map((r) => r.cursor),
    ).toEqual([null, "p2"]);
    const invalid = await f.client.send("thread.start", {
      ...f.payload,
      instanceId: "codex-test",
      model: { id: "gpt-5.4", options: { effort: "invalid" } },
    });
    expect(invalid.receipt.kind).toBe("rejected");
    accepted((await f.send()).receipt, "threadStarted");
    await f.waitTerminal();
    expect(f.updates.at(-1)).toMatchObject({
      kind: "executor.failed",
      reason: "notAuthenticated",
      message: "Model unavailable for this account: [redacted]",
    });
    expect((await refresh(f)).models).toEqual(r.models);
    f.updates.length = 0;
    accepted(
      (await f.client.send("thread.start", { ...f.payload, model: { id: "other", options: {} } }))
        .receipt,
      "threadStarted",
    );
    await f.waitTerminal();
    expect(f.updates.at(-1)?.kind).toBe("round.ended");
  });
  await scenario({ gate: "account" }, async (f) => {
    await configure(f);
    const signals = f.signals;
    if (!signals) throw Error("Missing account gate");
    const replaceRegistration = async () => {
      try {
        await signals.wait("gate.account");
        const next = structuredClone(f.registration);
        next.driver.variables.PEER_GATE.value = "";
        next.driver.variables.PEER_VERSION.value = "0.159.0";
        next.credential.key = "replacement";
        accepted((await f.configure("1", next)).receipt, "executorConfigured");
        expect((await refresh(f)).binaryVersion).toBe("0.159.0");
      } finally {
        signals.release();
      }
    };
    const [previous] = await Promise.all([f.refresh(), replaceRegistration()]);
    expect(previous.receipt.kind).toBe("rejected");
    expect(String((await refresh(f)).configurationVersion)).toBe("2");
  });
}, 60000);
test("4. effective ask policy, early root, original tool and assistant frames, and native end; incompatible open sends no input", async () => {
  await scenario({ kind: "early" }, async (f) => {
    await configure(f);
    await refresh(f);
    const ids = accepted(
      (
        await f.client.send("thread.start", {
          ...f.payload,
          instanceId: "codex-test",
          model: { id: "gpt-5.4", options: { effort: "medium" } },
        })
      ).receipt,
      "threadStarted",
    );
    await f.waitTerminal();
    expect(f.updates.map((x) => x.kind)).toEqual([
      "round.started",
      "tool.started",
      "tool.output",
      "tool.ended",
      "assistant.delta",
      "assistant.delta",
      "assistant.final",
      "round.ended",
    ]);
    expect(f.updates[0]).toMatchObject({
      effectiveMode: "ask",
      enforcement: "native",
      supportedModes: ["ask"],
    });
    expect(f.updates[2]).toMatchObject({ text: "amber\n", callId: "sample-command" });
    expect(f.updates[3]).toMatchObject({ exitCode: 0, output: "amber\n" });
    expect(f.updates[4]).toMatchObject({ text: "The marker was " });
    expect(f.updates[5]).toMatchObject({ text: "amber." });
    expect(f.updates[6]).toMatchObject({ text: "The marker was amber." });
    expect(f.ledger.rows().filter((r) => r.event === "turn/start" && r.hasInput)).toMatchObject([
      { clientId: ids.deliveryId },
    ]);
    expect(f.ledger.rows().filter((r) => r.event === "root")).toHaveLength(1);
    const captureId = await finishedCapture(f.client, ids);
    await inspectStoppedWriter(f, (db) => {
      expect(readRound(db, ids.roundId)?.attempt.phase).toMatchObject({
        kind: "finished",
        captureId,
        receipt: null,
        endedAt: 1767225603000,
        endTimeEvidence: {
          source: "executorReported",
          executorEndedAt: 1767225603000,
          environmentObservedAt: expect.any(Number),
        },
      });
    });
  });
  await scenario({ kind: "history" }, async (f) => {
    await configure(f);
    await refresh(f);
    accepted((await f.send()).receipt, "threadStarted");
    await f.waitTerminal();
    const lookup = f.ledger.rows().filter((row) => row.event === "thread/read");
    expect(lookup).toHaveLength(1);
    expect(f.updates.at(-1)).toMatchObject({ kind: "round.ended", endedAt: 1767225603000 });
  });
  await scenario({ kind: "mismatch", gate: "policy" }, async (f) => {
    await configure(f);
    await refresh(f);
    accepted((await f.send()).receipt, "threadStarted");
    if (!f.signals) throw Error("Missing policy gate");
    await f.signals.wait("gate.policy");
    f.signals.release();
    await f.waitTerminal();
    expect(f.updates.at(-1)).toMatchObject({ kind: "executor.failed", reason: "unsupported" });
    const policy = f.ledger.rows().find((r) => r.event === "policy" && r.probe === false);
    expect(policy?.approvalPolicy).toBe("never");
    expect(
      f.ledger.rows().filter((r) => r.handle === policy?.handle && r.event === "turn/start"),
    ).toHaveLength(0);
  });
}, 60000);

test("existing-thread input uses its original Codex registration and records one native delivery on replay", async () => {
  await scenario({}, async (f) => {
    await configure(f);
    await refresh(f);
    const first = accepted((await f.send()).receipt, "threadStarted");
    await f.waitTerminal();
    f.updates.length = 0;
    const payload = { threadId: first.threadId, content: f.payload.content };
    const receipt = (await f.client.send("input.send", payload, "second-input")).receipt;
    const second = accepted(receipt, "inputScheduled");
    await f.waitTerminal();
    expect(f.updates.at(-1)).toMatchObject({
      kind: "round.ended",
      roundId: second.roundId,
      attemptId: second.attemptId,
    });
    expect((await f.client.send("input.send", payload, "second-input")).receipt).toEqual(receipt);
    const captureId = await finishedCapture(f.client, { ...second, threadId: first.threadId });
    const history = await f.client.readInputHistory(first.threadId, second.roundId);
    expect(history.rounds[0]?.attempts).toMatchObject([
      {
        attemptId: second.attemptId,
        deliveryId: second.deliveryId,
        phase: { kind: "finished", captureId },
      },
    ]);
    expect(
      f.ledger
        .rows()
        .filter((row) => row.event === "turn/start" && row.hasInput)
        .map((row) => row.clientId),
    ).toEqual([first.deliveryId, second.deliveryId]);
  });
}, 60000);
