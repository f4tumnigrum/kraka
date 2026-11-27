import { test, expect } from "bun:test";
import { join } from "node:path";
import * as v from "valibot";
import { decodeFrame, ThreadIdSchema, type SyncCursor } from "@kraka/protocol";
import { SqliteThreadCache } from "../packages/cli-client/src/thread-cache";
import { cachedHistory, installHistoryPage, scopeKey } from "../packages/client-runtime/src";
import { utf8 } from "../packages/daemon/src/flow-socket";
import { accepted, productRoot } from "./fixtures/first-send";
import { codexFixture } from "./fixtures/codex-turn";
import { connectReplica, threadFixture, turnRows } from "./fixtures/thread-resume";
import { startPairedProject, commandId } from "./fixtures/paired-project";
import { Journal } from "./fixtures/route-network";
import { withState, within } from "./fixtures/replay-process";
import { installedTool, expand, toolFact, type ActivityClient } from "./fixtures/tool-activity";

test(
  "1. Live output while the recorded parent is running",
  () =>
    withState(async (dir) => {
      const pair = await startPairedProject({
        stateDir: dir,
        projectId: "initial",
        requests: [["thread.view"]],
      });
      const gates = new Map([12, 13, 14, 16, 19].map((n) => [n, Promise.withResolvers<void>()]));
      const entered = new Journal<number>();
      const gate = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(req) {
          const seq = Number(new URL(req.url).pathname.slice(1));
          entered.push(seq);
          await gates.get(seq)?.promise;
          return new Response("ok");
        },
      });
      const clients: ActivityClient[] = [],
        caches: SqliteThreadCache[] = [];
      try {
        const f = await codexFixture(
          dir,
          {},
          productRoot,
          true,
          undefined,
          join(pair.stateDir, "host"),
        );
        try {
          const reg = {
            ...f.registration,
            driver: {
              ...f.registration.driver,
              variables: {
                ...f.registration.driver.variables,
                PEER_FRAME_GATE: { kind: "literal", value: gate.url.href },
              },
            },
          };
          accepted((await f.configure(null, reg)).receipt, "executorConfigured");
          accepted((await f.refresh()).receipt, "executorRefreshed");
          const ids = accepted((await f.send()).receipt, "threadStarted");
          await entered.until((n) => n === 12);
          await pair.host.control("project", { projectId: f.project.id, threadId: ids.threadId });
          const tablet = pair.clients[0]!;
          accepted(
            await pair.owner.request({
              commandId: commandId(),
              method: "access.grant",
              payload: {
                principalId: tablet.principal.id,
                target: { kind: "thread", threadId: ids.threadId },
                permission: "thread.view",
                modeCeiling: "ask",
                inheritance: "targetOnly",
              },
            }),
            "accessChanged",
          );
          const installs = new Journal<SyncCursor>();
          for (const [i, device] of [pair.owner, tablet].entries()) {
            const cache = new SqliteThreadCache(
              join(dir, "replica-" + i + ".sqlite"),
              device.principal.id,
            );
            caches.push(cache);
            const c = await connectReplica(f.instance.endpoint, pair.identity, device, cache, {
              minor: 1,
              installed: (h) => {
                if (i === 0) installs.push(h);
              },
            });
            clients.push(c);
            accepted(await (await c.client.open(ids.threadId, null)).receipt, "subscriptionOpened");
          }
          gates.get(12)!.resolve();
          await entered.until((n) => n === 13);
          const c = clients[0]!;
          await installs.until(() =>
            Object.values(c.cache.read().rows).some((r) => r.row?.objectType === "timelineItem"),
          );
          const row = installedTool(c);
          expect(row).toMatchObject({
            phase: "started",
            source: { callId: "sample-command" },
            assignment: { attemptId: ids.attemptId },
          });
          const detail = await expand(c, row, row.version);
          const input = (await detail.at("1")).body.input;
          expect(JSON.parse(input.kind === "captured" ? input.json : "null")).toEqual({
            cwd: "/sample/workspace",
            command: "printf 'amber\\n'",
          });
          const collapsed = await expand(c, row);
          expect((await collapsed.at("1")).item.id).toBe(row.id);
          await collapsed.viewer.close();
          gates.get(13)!.resolve();
          expect((await detail.at("2")).body.output).toMatchObject({
            kind: "partial",
            text: "amber\n",
          });
          gates.get(14)!.resolve();
          expect((await detail.at("3")).body).toMatchObject({
            output: { kind: "complete", text: "amber\n" },
            exitCode: 0,
            success: true,
          });
          expect(collapsed.versions.items).toHaveLength(1);
          gates.get(16)!.resolve();
          const delta = await f.events.until((e) => e.kind === "assistant.delta");
          expect(delta).toMatchObject({ roundId: ids.roundId, text: "The marker was " });
          await entered.until((n) => n === 19);
          expect(f.updates.some((e) => e.kind === "round.ended")).toBe(false);
          gates.get(19)!.resolve();
          await f.events.until((e) => e.kind === "round.ended");
        } finally {
          for (const g of gates.values()) g.resolve();
          await Promise.all(clients.map((c) => c.close()));
          await f.close();
        }
      } finally {
        for (const c of caches) c.close();
        await gate.stop(true);
        await pair.close();
      }
    }),
  60000,
);

test(
  "2. Reopen after restart outside the recent window",
  () =>
    threadFixture(async (f) => {
      await f.start();
      await f.control({ activity: toolFact(f.threadId, "started") });
      const signal = Promise.withResolvers<SyncCursor>();
      const c = await f.connect("desktop", { installed: signal.resolve });
      await (await c.client.open(f.threadId, null)).receipt;
      await signal.promise;
      const row = installedTool(c);
      const viewing = await expand(c, row);
      await viewing.at("1");
      await c.close();
      expect(c.client.cachedActivity(f.threadId, row.id)).toMatchObject({
        verified: false,
        view: { body: { status: "running", exitCode: null } },
      });
      const change = {
        path: "result.txt",
        change: "modified",
        destination: null,
        patch: "+changed\n",
      };
      await f.control({
        unattributed: {
          ...change,
          threadId: f.threadId,
          attemptId: "attempt-1",
          path: "other.txt",
          eventId: "file",
        },
      });
      await f.control({
        activity: { ...toolFact(f.threadId, "ended", "failed\n", 17), changes: [change] },
      });
      await f.control({
        transactions: Array.from({ length: 15 }, (_, i) => turnRows(f.threadId, i + 1)),
      });
      await f.restart();
      const opened = Promise.withResolvers<SyncCursor>();
      const fresh = await f.connect("fresh", { installed: opened.resolve });
      await (await fresh.client.open(f.threadId, null)).receipt;
      const head = await opened.promise;
      expect(
        Object.values(fresh.cache.read().scopes[scopeKey(head)]!.members).some(
          (k) => k.id === row.id,
        ),
      ).toBe(false);
      const detail = await expand(fresh, row);
      expect((await detail.at("2")).body).toMatchObject({
        input: { kind: "captured", json: JSON.stringify({ command: "check changes" }) },
        output: { kind: "complete", text: "failed\n" },
        status: "failed",
        exitCode: 17,
        changes: [change],
      });
      const legacy = await f.connect("legacy", { timeline: false });
      expect(
        await legacy.client.readActivity({
          threadId: f.threadId,
          itemId: row.id,
          expectedVersion: null,
          onVersion() {
            throw Error("Unexpected legacy detail");
          },
        }),
      ).toEqual({ kind: "unsupported" });
    }),
  25000,
);

test(
  "3. Ancestor and delayed page retain independent positions",
  () =>
    threadFixture(async (f) => {
      await f.start();
      await f.seed(turnRows(f.threadId, 1));
      await f.control({ activity: { ...toolFact(f.threadId, "started"), roundId: "round-1" } });
      const fork = v.parse(ThreadIdSchema, "fork");
      await f.seed([
        {
          objectType: "thread",
          value: {
            id: fork,
            projectId: "project-notes",
            worktreeId: null,
            title: "Fork",
            version: "1",
            lineage: {
              kind: "fork",
              parentThreadId: f.threadId,
              sourceRoundId: "round-1",
              sideChat: false,
            },
          },
        },
      ]);
      await f.control({
        transactions: Array.from({ length: 12 }, (_, i) => turnRows(fork, i + 100)),
      });
      const heads = new Journal<SyncCursor>();
      const c = await f.connect("tablet", { installed: (h) => heads.push(h) });
      await (await c.client.open(fork, null)).receipt;
      const initial = await heads.until(() => true);
      const page = await c.client.history(initial, null, () => true);
      const before = installedTool(c);
      await f.control({
        activity: { ...toolFact(f.threadId, "ended", "done", 0), roundId: "round-1" },
      });
      await heads.until((h) => h.through !== initial.through);
      await installHistoryPage(c.cache, page, {
        head: initial,
        threadId: fork,
        anchor: page.anchor,
        timelineItems: true,
        allows: () => true,
      });
      expect(installedTool(c)).toMatchObject({
        ...before,
        version: "2",
        phase: "ended",
        outputSummary: "done",
      });
      expect(cachedHistory(c.cache.read(), page.anchor, null)?.verifiedAt).toEqual(initial);
      expect(
        (await (await expand(c, { threadId: fork, id: before.id })).at("2")).body.exitCode,
      ).toBe(0);
    }),
  20000,
);

test(
  "4. Isolation keeps thread summaries moving and denies foreign detail",
  () =>
    threadFixture(
      async (f) => {
        await f.start();
        const text = "你好\n".repeat(16000);
        await f.control({
          activity: { ...toolFact(f.threadId, "ended", text, 0), inputJson: "{}" },
        });
        const installed = Promise.withResolvers<SyncCursor>(),
          blocked = Promise.withResolvers<void>();
        let stream = 0,
          paused = true,
          pending: (() => void) | undefined,
          dataBytes = 0;
        const c = await f.connect("viewer", {
          installed: installed.resolve,
          write(w, send) {
            if (paused && stream && typeof w === "string") {
              const frame = JSON.parse(w);
              if (frame.lane === "window" && frame.streamId === stream) {
                pending = () => send(w);
                return;
              }
            }
            send(w);
          },
          wire(w) {
            const frame = decodeFrame(w, utf8);
            if (frame.lane === "data" && frame.message.kind === "tool.activity.detail")
              stream = frame.streamId;
            if (frame.lane === "data" && frame.streamId === stream) {
              dataBytes += typeof w === "string" ? Buffer.byteLength(w) : w.length;
              if (dataBytes === 4096) blocked.resolve();
            }
          },
        });
        await (await c.client.open(f.threadId, null)).receipt;
        await installed.promise;
        const row = installedTool(c);
        const detail = await expand(c, row);
        await within(blocked.promise, 5000, "paused detail");
        const h = new Journal<SyncCursor>();
        const other = await f.connect("tablet", { installed: (x) => h.push(x) });
        await (await other.client.open(f.threadId, null)).receipt;
        await h.until(() => true);
        const newTitle = "Edited while paused";
        accepted(
          await other.client.rpc("thread.rename", { threadId: f.threadId, title: newTitle }),
          "threadRenamed",
        );
        await h.until(() =>
          Object.values(other.cache.read().rows).some(
            (r) => r.row?.objectType === "thread" && r.row.value.title === newTitle,
          ),
        );
        expect(dataBytes).toBe(4096);
        expect(detail.versions.items).toBeEmpty();
        paused = false;
        pending?.();
        const body = await detail.at("1");
        expect(body.body.output).toEqual({ kind: "complete", text });
        const foreign = v.parse(ThreadIdSchema, "foreign");
        await f.seed([
          {
            objectType: "thread",
            value: {
              id: foreign,
              projectId: "private-project",
              worktreeId: null,
              title: "Private",
              version: "1",
              lineage: { kind: "root" },
            },
          },
        ]);
        await f.control({ activity: toolFact(foreign, "ended", "private bytes", 0) });
        const ready = Promise.withResolvers<SyncCursor>();
        const owner = await f.connect("foreign-owner", { installed: ready.resolve });
        const o = await owner.client.open(foreign, null);
        await o.receipt;
        const page = await ready.promise;
        const foreignRow = installedTool(owner);
        expect(page.scope).toEqual({ kind: "thread", threadId: foreign });
        const deniedFrames: number[] = [];
        const denied = await f.connect("tablet", {
          wire(w) {
            const frame = decodeFrame(w, utf8);
            if (frame.lane === "data") deniedFrames.push(frame.streamId);
          },
        });
        await expect(
          denied.client.readActivity({
            threadId: foreign,
            itemId: foreignRow.id,
            expectedVersion: null,
            onVersion() {
              throw Error("Foreign bytes");
            },
          }),
        ).rejects.toThrow("notFound");
        await f.control({
          ledger: { epoch: denied.client.hello.connectionId, streamId: 1, bytes: 0 },
        });
        expect(deniedFrames).toBeEmpty();
      },
      productRoot,
      true,
    ),
  30000,
);
