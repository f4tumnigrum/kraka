import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import * as v from "valibot";
import { InstancePublicationSchema, readInstancePublication } from "@kraka/environment";
import type { ExecutorTurnUpdate } from "@kraka/protocol";
import { accepted, configureLocalOwner, productRoot } from "./first-send";
import { connectFirstSend, fixtureActor } from "./first-send-client";
import { commandId, startPairedProject } from "./paired-project";
import { connectReplica } from "./thread-resume";
import { Journal } from "./route-network";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { sampleRequest, within, terminate, captureStderr } from "./replay-process";
import { seedGit } from "./isolated-start";

export async function usageBinaries(dir: string) {
  if (Bun.version !== "1.4.5") throw Error("S42 requires Bun 1.4.5");
  async function compile(name: string) {
    const path = join(dir, name + (process.platform === "win32" ? ".exe" : ""));
    const p = Bun.spawn(
      [process.execPath, "build", "--compile", "tools/fixtures/" + name + ".ts", "--outfile", path],
      { cwd: productRoot, stdout: "ignore", stderr: "pipe" },
    );
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    if (code !== 0) throw Error(err);
    return path;
  }
  return { peer: await compile("codex-usage-peer"), daemon: await compile("account-usage-daemon") };
}
const callSchema = v.object({
  account: v.string(),
  method: v.string(),
  session: v.nullable(v.string()),
  params: v.record(v.string(), v.unknown()),
});
const note = v.looseObject({ kind: v.string() });
export type PeerCall = v.InferOutput<typeof callSchema>;
export type QuotaResult = { result?: unknown; error?: unknown };
export const limits = (used: number, reset: number | null) => ({
  result: {
    rateLimits: {},
    rateLimitsByLimitId: {
      standard: {
        primary: { usedPercent: 35, windowDurationMins: 300, resetsAt: null },
        secondary: { usedPercent: used, windowDurationMins: 10080, resetsAt: reset },
      },
    },
  },
});
export const failure = { error: { code: -32000, message: "Synthetic probe failed" } };
export async function usageCase(bins: Awaited<ReturnType<typeof usageBinaries>>) {
  const directory = await mkdtemp(join(tmpdir(), "kraka-account-case-"));
  const cleanup: (() => void | Promise<unknown>)[] = [
    () => rm(directory, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 }),
  ];
  const held = new Set<() => void>(),
    ledger = new Journal<PeerCall>(),
    signals = new Journal<v.InferOutput<typeof note>>();
  const responses = new Map<string, () => Promise<QuotaResult>>();
  let repeat: Promise<void> | null = null;
  let limited: { reset: number | null } | null = null,
    duplicate = false,
    sessionFee: number | null = null,
    prompts = 0;
  const controller = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const c = v.parse(callSchema, await req.json());
      ledger.push(c);
      if (c.method === "fixture/repeatUsage") {
        await repeat;
        return new Response(null, { status: 204 });
      }
      if (c.method === "account/rateLimits/read")
        return Response.json((await responses.get(c.account)?.()) ?? limits(0, null));
      if (c.method === "account/usage/read")
        return Response.json({
          result: {
            threadUsage: sessionFee === null ? null : { nativeUsageUsdMicros: sessionFee },
          },
        });
      if (c.method !== "turn/start") throw Error("Unexpected peer request " + c.method);
      const turnId = "native-turn-" + ++prompts,
        threadId = c.session,
        turn = { id: turnId, status: "inProgress", startedAt: 1 };
      const tokens = {
        inputTokens: 1000000,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 1000000,
      };
      const usage = {
        method: "thread/tokenUsage/updated",
        params: { threadId, turnId, tokenUsage: { last: tokens, total: tokens } },
      };
      const notices = [
        { method: "turn/started", params: { threadId, turn } },
        {
          method: "item/started",
          params: {
            threadId,
            turnId,
            item: {
              type: "userMessage",
              id: "input-" + turnId,
              clientId: c.params.clientUserMessageId,
            },
          },
        },
        ...(duplicate
          ? [
              {
                method: "account/rateLimits/updated",
                params: {
                  rateLimits: {
                    limitId: "standard",
                    primary: { usedPercent: 91, windowDurationMins: 300 },
                  },
                },
              },
            ]
          : []),
        ...(!limited ? [usage, ...(duplicate ? [usage] : [])] : []),
        {
          method: "turn/completed",
          params: {
            threadId,
            turn: {
              ...turn,
              status: limited ? "failed" : "completed",
              completedAt: 2,
              error: limited
                ? {
                    message: "Synthetic quota limit",
                    codexErrorInfo: "usageLimitExceeded",
                    resetsAt: limited.reset,
                  }
                : null,
            },
          },
        },
      ];
      return Response.json({ result: { turn }, notices });
    },
  });
  cleanup.push(() => controller.stop(true));
  async function close() {
    for (const release of held) release();
    const errors: unknown[] = [];
    for (const dispose of cleanup.splice(0).reverse())
      try {
        await dispose();
      } catch (e) {
        errors.push(e);
      }
    if (errors.length) throw new AggregateError(errors, "Account fixture cleanup");
  }
  try {
    const pair = await startPairedProject({
      stateDir: directory,
      projectId: "project-fixture",
      requests: [["thread.view"]],
    });
    cleanup.push(pair.close);
    const state = join(pair.stateDir, "host"),
      target = { kind: "environment" as const, environmentId: pair.identity.id };
    await configureLocalOwner(state, [
      "thread.view",
      "settings.change",
      "workspace.change",
      "thread.send",
    ]);
    const writer = Bun.spawn([bins.daemon, state], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = captureStderr(writer.stderr),
      closed = writer.exited.then(async (code) => {
        if (code !== 0) throw Error("Quota daemon exited " + code + ": " + (await stderr.drained));
      });
    void closed.catch(() => {});
    const lines = (async () => {
      for await (const line of createInterface({
        input: Readable.fromWeb(writer.stdout),
        crlfDelay: Infinity,
      }))
        signals.push(v.parse(note, JSON.parse(line)));
    })();
    cleanup.push(async () => {
      try {
        await writer.stdin.end();
        await within(closed, 15000, "Quota daemon EOF");
      } finally {
        await terminate(writer);
        await lines;
        await stderr.drained;
      }
    });
    const ready = await Promise.race([
      signals.until((m) => m.kind === "ready", 0, 10000),
      closed.then(() => {
        throw Error("Quota daemon closed before ready");
      }),
    ]);
    const pub = v.parse(InstancePublicationSchema, ready.publication);
    if (pub.pid !== writer.pid || !Bun.deepEquals(pub, await readInstancePublication(state)))
      throw Error("Unconfirmed case endpoint");
    const events = new Journal<ExecutorTurnUpdate>(),
      admin = await connectFirstSend(state, pub, (e) => events.push(e));
    cleanup.push(admin.close);
    const cwd = await realpath(seedGit(directory, "project").path);
    const project = accepted(
      (await admin.send("project.register", { realPath: cwd })).receipt,
      "projectRegistered",
    ).project;
    async function configure(id: string, version: "1" | "2" = "1") {
      const home = join(directory, id + "-" + version);
      await mkdir(home, { recursive: true });
      const credential = { ownerId: fixtureActor, namespace: id, key: "synthetic", version };
      const registration = {
        family: "codex",
        instanceId: id,
        displayName: id,
        enabled: true,
        driver: {
          executable: bins.peer,
          endpoint: null,
          configurationRoot: home,
          historyRoot: home,
          variables: {
            S42_HISTORY: { kind: "literal", value: "1" },
            S42_CONTROL: { kind: "literal", value: controller.url.href },
            S42_ACCOUNT: { kind: "secret", binding: credential },
          },
        },
        credential,
        model: { id: "fixture", options: {} },
        permission: { ceiling: "ask", selected: "ask" },
      };
      accepted(
        (
          await admin.send("executor.configure", {
            expectedVersion: version === "1" ? null : "1",
            registration,
          })
        ).receipt,
        "executorConfigured",
      );
      const probe = accepted(
        (await admin.send("executor.refresh", { instanceId: id, projectId: project.id })).receipt,
        "executorRefreshed",
      );
      if (Object.values(probe.readiness).some((r) => r.state !== "yes"))
        throw Error("Case executor not ready " + JSON.stringify(probe.readiness));
    }
    for (const id of ["A", "B"]) await configure(id);
    const second = pair.clients[0];
    if (!second) throw Error("Missing second registration");
    async function connect(device: typeof pair.owner) {
      const cache = new SqliteThreadCache(
        join(directory, device.device.deviceId + ".sqlite"),
        device.principal.id,
      );
      cleanup.push(() => cache.close());
      const remote = await connectReplica(pub.endpoint, pair.identity, device, cache, { minor: 2 });
      cleanup.push(remote.close);
      return remote;
    }
    const one = await connect(pair.owner),
      two = await connect(second);
    const grant = () =>
      pair.owner
        .request({
          method: "access.grant",
          commandId: commandId(),
          payload: {
            target,
            principalId: second.principal.id,
            permission: "thread.view",
            modeCeiling: "ask",
            inheritance: "children",
          },
        })
        .then((r) => accepted(r, "accessChanged"));
    async function read(id = "A", device = one, subscribe?: boolean) {
      return accepted(
        await device.client.rpc("executor.readQuota", {
          instanceId: id,
          ...(subscribe === undefined ? {} : { subscribe }),
        }),
        "accountQuota",
      ).snapshot;
    }
    async function refresh(id = "A", device = one) {
      return accepted(
        await device.client.rpc("executor.refreshQuota", { instanceId: id }),
        "accountQuota",
      ).snapshot;
    }
    async function advance(at: number) {
      const token = crypto.randomUUID();
      writer.stdin.write(JSON.stringify({ at, token }) + "\n");
      await writer.stdin.flush();
      return (await signals.until((m) => m.kind === "advanced" && m.token === token, 0, 12000))
        .counts;
    }
    async function startTurn(threadId?: string) {
      const content = sampleRequest.input;
      const begin = threadId
        ? accepted(
            (await admin.send("input.send", { threadId, content })).receipt,
            "inputScheduled",
          )
        : accepted(
            (
              await admin.send("thread.start", {
                projectId: project.id,
                instanceId: "A",
                worktreeId: null,
                content,
              })
            ).receipt,
            "threadStarted",
          );
      const thread = threadId ?? ("threadId" in begin ? begin.threadId : null);
      if (!thread) throw Error("Missing original thread");
      return {
        roundId: begin.roundId,
        thread,
        ended: () =>
          events.until((e) => e.kind === "round.ended" && e.roundId === begin.roundId, 0, 15000),
      };
    }
    return {
      one,
      two,
      target,
      grant,
      advance,
      configure,
      read,
      refresh,
      startTurn,
      turn: async (thread?: string) => {
        const turn = await startTurn(thread);
        await turn.ended();
        return turn;
      },
      ledger,
      signals,
      close,
      usage: async (thread: string) =>
        accepted(await one.client.rpc("thread.readUsage", { threadId: thread }), "threadUsage"),
      setResult: (id: string, result: QuotaResult) => responses.set(id, async () => result),
      setTurn: (options: {
        limited?: { reset: number | null };
        duplicate?: boolean;
        fee?: number;
      }) => {
        limited = options.limited ?? null;
        duplicate = options.duplicate ?? false;
        sessionFee = options.fee ?? null;
      },
      holdDuplicate() {
        const barrier = Promise.withResolvers<void>();
        repeat = barrier.promise;
        const release = () => {
          held.delete(release);
          barrier.resolve();
        };
        held.add(release);
        return release;
      },
      hold(id: string, result: QuotaResult) {
        const barrier = Promise.withResolvers<void>(),
          since = ledger.items.length;
        const release = () => {
          held.delete(release);
          barrier.resolve();
        };
        held.add(release);
        responses.set(id, async () => {
          await barrier.promise;
          return result;
        });
        return {
          received: () =>
            ledger.until(
              (c) => c.account === id && c.method === "account/rateLimits/read",
              since,
              8000,
            ),
          release,
        };
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
