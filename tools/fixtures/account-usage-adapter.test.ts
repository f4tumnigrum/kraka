import { expect, test } from "bun:test";
import { settingsHost } from "./settings-host";
import { withState } from "./replay-process";
import { accepted } from "./first-send";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  MessageIdSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  StoredRegistrationSchema,
} from "@kraka/protocol";
import { createCodexAdapter, probeCodex } from "../../packages/adapter-codex/src/index";
import type { AdapterEventPayload } from "@kraka/environment";

test("A compiled Codex peer reports account windows without opening a turn and keeps session fees separate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kraka-quota-peer-"));
  const calls: string[] = [];
  const wire = v.object({
    account: v.string(),
    method: v.string(),
    session: v.nullable(v.string()),
    params: v.record(v.string(), v.unknown()),
  });
  const controller = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const r = v.parse(wire, await req.json());
      calls.push(r.account + "/" + r.method);
      switch (r.method) {
        case "account/rateLimits/read":
          return Response.json({
            result: {
              rateLimits: {},
              rateLimitsByLimitId: {
                standard: {
                  secondary: { usedPercent: 100, windowDurationMins: 10080, resetsAt: 999 },
                  primary: { usedPercent: 78 },
                },
              },
            },
          });
        case "account/usage/read":
          return Response.json({
            result: {
              threadUsage: { nativeUsageUsdMicros: 2300000, estimatedUsageCreditsMicros: 0 },
            },
          });
        case "turn/start": {
          const turn = {
            id: "native-root",
            rootTurnId: "native-root",
            status: "inProgress",
            startedAt: 1,
          };
          const threadId = r.session,
            turnId = turn.id;
          const last = {
            inputTokens: 1000,
            cachedInputTokens: 250,
            outputTokens: 75,
            reasoningOutputTokens: 25,
            totalTokens: 1075,
          };
          const usage = {
            method: "thread/tokenUsage/updated",
            params: {
              threadId,
              turnId,
              tokenUsage: { last, total: { ...last, inputTokens: 9000, totalTokens: 9075 } },
            },
          };
          return Response.json({
            result: { turn },
            notices: [
              { method: "turn/started", params: { threadId, turn } },
              usage,
              usage,
              {
                method: "turn/completed",
                params: {
                  threadId,
                  turn: {
                    ...turn,
                    status: "failed",
                    completedAt: 2,
                    error: {
                      message: "Quota reached",
                      codexErrorInfo: "usageLimitExceeded",
                      resetsAt: 999,
                    },
                  },
                },
              },
            ],
          });
        }
        default:
          throw Error("Unexpected RPC " + r.method);
      }
    },
  });
  try {
    const executable = join(dir, process.platform === "win32" ? "peer.exe" : "peer");
    const compile = Bun.spawn(
      [
        process.execPath,
        "build",
        "--compile",
        resolve(import.meta.dir, "codex-usage-peer.ts"),
        "--outfile",
        executable,
      ],
      { stdout: "ignore", stderr: "pipe" },
    );
    const [code, errors] = await Promise.all([compile.exited, new Response(compile.stderr).text()]);
    if (code !== 0) throw Error(errors);
    const deliveryId = v.parse(DeliveryIdSchema, "delivery");
    for (const label of ["A", "B"]) {
      const home = join(dir, label);
      await mkdir(home);
      const registration = v.parse(StoredRegistrationSchema, {
        family: "codex",
        instanceId: label,
        version: "1",
        displayName: label,
        enabled: true,
        driver: {
          executable,
          endpoint: null,
          configurationRoot: home,
          historyRoot: home,
          variables: {},
        },
        credential: { ownerId: "fixture", namespace: label, key: label, version: "1" },
        model: { id: "fixture", options: {} },
        permission: { ceiling: "ask", selected: "ask" },
      });
      const launch = {
        executable,
        cwd: dir,
        env: { CODEX_HOME: home, S42_ACCOUNT: label, S42_CONTROL: controller.url.href },
      };
      const probe = await probeCodex(registration, launch);
      expect(Object.values(probe.declaration.readiness).map((x) => x.state)).toEqual(
        Array(5).fill("yes"),
      );
      expect(probe.declaration.matrix.reportQuota.kind).toBe("native");
      const instance = { family: "codex" as const, instanceId: registration.instanceId },
        adapter = createCodexAdapter(instance, launch, probe);
      const permit = {
        ...instance,
        support: { kind: "native" } as const,
        capabilityVersion: probe.declaration.version,
      };
      const quota = await adapter.invoke(
        instance,
        { ...permit, capability: "reportQuota" },
        { kind: "service", capability: "reportQuota", deliveryId, request: { kind: "quota" } },
      );
      if (quota.kind !== "ok") throw Error("Quota read failed");
      expect(quota.value.result.windows).toMatchObject([
        { used: 78, resetAt: null },
        { kind: "weekly", used: 100, remaining: 0, resetAt: 999000 },
      ]);
      expect(calls.filter((x) => x.startsWith(label + "/"))).toEqual([
        label + "/account/rateLimits/read",
      ]);
      const attemptId = v.parse(AttemptIdSchema, "attempt"),
        opened = await adapter.open({
          instance,
          attemptId,
          resume: null,
          setup: {
            workingDirectory: dir,
            additionalDirectories: [],
            environment: launch.env,
            model: { id: "fixture", options: {} },
            permission: registration.permission,
          },
        });
      if (opened.kind !== "ok") throw Error("Native open failed");
      try {
        const session = opened.value,
          iter = adapter.events(session, null)[Symbol.asyncIterator](),
          first = iter.next();
        const receipt = await adapter.invoke(
          session,
          { ...permit, capability: "submitTextInput" },
          {
            kind: "deliverInput",
            capability: "submitTextInput",
            attemptId,
            deliveryId,
            input: {
              id: v.parse(MessageIdSchema, "message"),
              text: "usage",
              attachments: [],
              references: [],
            },
          },
        );
        expect(receipt.kind).toBe("ok");
        const payloads: AdapterEventPayload[] = [];
        for (let event = await first; !event.done; event = await iter.next())
          payloads.push(event.value.payload);
        expect(
          payloads.find((p) => p.kind === "usageUpdated" && p.scope === "round"),
        ).toMatchObject({
          counters: { uncachedInput: 750, cacheRead: 250, output: 75, reasoning: 25 },
          sourceId: "native-root",
        });
        expect(payloads.at(-1)).toMatchObject({
          kind: "roundEnded",
          outcome: { reason: "failed", failure: { kind: "usageLimit", resetAt: 999000 } },
        });
        expect(
          await adapter.invoke(
            session,
            { ...permit, capability: "reportCost" },
            {
              kind: "service",
              capability: "reportCost",
              request: { kind: "cost", scope: "session" },
              deliveryId,
            },
          ),
        ).toMatchObject({
          kind: "ok",
          value: {
            result: {
              scope: "session",
              amounts: [
                { currency: "USD", priceSource: "reported", amount: 2.3 },
                { currency: "credits", amount: 0 },
              ],
            },
          },
        });
      } finally {
        await adapter.close(opened.value, "finished");
      }
    }
  } finally {
    await controller.stop(true);
    await rm(dir, { force: true, recursive: true });
  }
}, 30000);

test("Signed readers see committed model rates and can read only an authorized thread", async () => {
  await withState(async (dir) => {
    const host = await settingsHost(dir, "usage");
    try {
      const { reader, owner, target } = host;
      const address = { field: "modelRates", target, checkout: null };
      const write = {
        ...address,
        baseVersion: "0",
        change: {
          kind: "set",
          value: { kind: "modelRates", models: { fixture: { currency: "USD", uncachedInput: 2 } } },
        },
      };
      expect(await reader.rpc("settings.write", write)).toMatchObject({
        kind: "rejected",
        failure: { kind: "missingPermission", permission: "settings.change" },
      });
      const saved = accepted(await owner.rpc("settings.write", write), "settingSaved");
      expect(saved.readback).toMatchObject({
        fieldVersion: "1",
        effective: { value: write.change.value },
      });
      expect(accepted(await reader.rpc("settings.read", address), "settingRead").readback).toEqual(
        saved.readback,
      );
      expect(await reader.rpc("thread.readUsage", { threadId: "missing-thread" })).toMatchObject({
        kind: "rejected",
        failure: { kind: "notFound" },
      });
      const { threadId } = accepted((await host.writer.send()).receipt, "threadStarted");
      expect(accepted(await reader.rpc("thread.readUsage", { threadId }), "threadUsage")).toEqual({
        kind: "threadUsage",
        threadId,
        buckets: [],
        limits: [],
      });
    } finally {
      await host.close();
    }
  });
}, 30000);
