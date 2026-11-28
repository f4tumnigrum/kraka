// Live cases 3; required groups ["1.", "2.", "3."]
import * as v from "valibot";
import { TextReturnedEventSchema } from "@kraka/protocol";
import { expect, test } from "bun:test";
import { join } from "node:path";
import { type SyncCursor } from "@kraka/protocol";
import {
  earlierPage,
  installedList,
  returnsForInput,
  type ListReading,
} from "../../packages/client-runtime/src";
import { threadFixture, turnRows } from "../fixtures/thread-resume";
import { choices, todoFor } from "../fixtures/todo";
import { browserProfiles, type AttentionFixture } from "../fixtures/attention-browser";
import { within } from "../fixtures/replay-process";

async function cli(f: AttentionFixture): Promise<ListReading> {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../packages/daemon/src/index.ts"),
      "thread",
      "list",
      "--json",
      "--project",
      f.pairing.projectId,
      "--environment",
      f.pairing.identity.id,
      "--endpoint",
      f.f.endpoint,
      "--device-dir",
      join(f.pairing.stateDir, "device-0"),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw Error("CLI list failed: " + err);
  return JSON.parse(out);
}
function thread(id: string, at?: number) {
  return {
    objectType: "thread",
    value: {
      id,
      title: id,
      projectId: "project-notes",
      worktreeId: null,
      lineage: { kind: "root" },
      version: "1",
      ...(at === undefined
        ? {}
        : { lifecycle: { archivedAt: null, state: { kind: "settled", at, reason: "manual" } } }),
    },
  };
}
const nativeRoot = { id: "native", sessionId: "session", beganAt: 1 };
function activity(id: string, i: number, phase: unknown, version = "1") {
  return turnRows(id, i).map((row) =>
    row.objectType === "round"
      ? {
          ...row,
          value: {
            ...row.value,
            version,
            attempt: { attemptId: "a" + i, deliveryId: "d" + i, phase },
          },
        }
      : row,
  );
}
function row(read: ListReading, id: string) {
  const match = read.rows.find((r) => r.summary.threadId === id);
  if (!match) throw Error("Missing " + id);
  return match;
}
test("1. J-6.4 lists native request outcomes, quota reset and background activity", async () => {
  await threadFixture(async (f) => {
    await f.control({ requests: "prepare" });
    await f.seed([
      thread("limited"),
      ...activity("limited", 10, { kind: "handed", wroteAt: 3 }),
      thread("background"),
      ...activity("background", 11, { kind: "working", root: nativeRoot, receipt: null }),
    ]);
    await f.control({ round: "round-10", quota: { resetAt: 124000 } });
    await f.control({ offer: "approval" });
    const initial = await cli(f);
    expect(row(initial, "limited")).toMatchObject({
      state: "quota",
      activity: [{ rounds: [{ quota: { resetAt: 124000 } }] }],
    });
    expect(row(initial, "background")).toMatchObject({
      state: "work",
      activity: [{ rounds: [{ round: { attempt: { phase: { kind: "working" } } } }] }],
    });
    expect(row(initial, f.threadId).requests).toMatchObject([
      {
        kind: "approval",
        actionable: true,
        key: { object: { requestId: todoFor("approval").id } },
      },
    ]);
    await f.control({ lose: "approval" });
    await f.control({ offer: "question" });
    const current = row(await cli(f), f.threadId);
    expect(
      current.activity[0]?.requests.find((r) => r.request.id === todoFor("approval").id)?.request
        .state.kind,
    ).toBe("expired");
    expect(current.requests).toMatchObject([
      {
        kind: "question",
        actionable: true,
        key: { object: { requestId: todoFor("question").id } },
      },
    ]);
  });
}, 60000);

test("2. S-THREAD-013/014 compares sealed desktop, phone and CLI and resolves one original request", async () => {
  await threadFixture(async (f) => {
    await f.control({ requests: "prepare" });
    const initial = await cli(f);
    await browserProfiles(f, async (profiles) => {
      async function compare(read: ListReading) {
        for (const profile of profiles) {
          const view = await profile.at(read.head.through);
          expect(view).toEqual(read);
          expect(
            await profile.page
              .locator("section")
              .filter({ has: profile.page.getByRole("heading", { name: "Draft notes" }) })
              .locator("output")
              .textContent(),
          ).toBe(row(read, f.threadId).state);
        }
      }
      await compare(initial);
      expect(row(initial, f.threadId)).toMatchObject({
        state: "preparation",
        activity: [{ rounds: [{ round: { attempt: { phase: { kind: "filed" } } } }] }],
      });
      await f.control({ offer: "approval" });
      await f.control({ offer: "question" });
      const open = await cli(f);
      await compare(open);
      const keys = row(open, f.threadId).requests.map((r) => ({
        kind: r.kind,
        threadId: r.key.threadId,
        object: r.key.object,
        actionable: r.actionable,
      }));
      expect(keys).toHaveLength(2);
      expect(keys).toMatchObject(
        ["approval", "question"].map((k) => ({
          kind: k,
          threadId: f.threadId,
          object: { kind: "request", requestId: todoFor(k).id },
          actionable: true,
        })),
      );
      for (const p of profiles) {
        expect(await p.page.locator("button:enabled").count()).toBe(2);
      }
      const winner = await profiles[1]!.page.evaluate(
        async (command) => {
          const host = globalThis as unknown as {
            list: { reply: (command: unknown) => Promise<unknown> };
          };
          return host.list.reply(command);
        },
        {
          method: "todo.decide",
          payload: {
            threadId: f.threadId,
            todoRequestId: todoFor("approval").id,
            decision: choices[0],
          },
        },
      );
      expect(winner).toMatchObject({ kind: "accepted", result: { kind: "todoAnswerStored" } });
      const updated = await cli(f);
      await compare(updated);
      expect(row(updated, f.threadId).requests).toMatchObject([
        {
          kind: "question",
          actionable: true,
          key: { object: { requestId: todoFor("question").id } },
        },
      ]);
      expect(
        row(updated, f.threadId).activity[0]?.requests.find(
          (r) => r.request.id === todoFor("approval").id,
        )?.request.state.kind,
      ).toBe("answered");
      const reviewId = "reviewed";
      const phase = {
        kind: "finished",
        captureId: "capture",
        root: nativeRoot,
        receipt: null,
        endedAt: 10,
        endTimeEvidence: {
          source: "executorReported",
          executorEndedAt: 10,
          environmentObservedAt: 12,
        },
      };
      await f.seed([thread(reviewId), ...activity(reviewId, 44, phase)]);
      const completed = await cli(f);
      await compare(completed);
      const before = row(completed, reviewId);
      expect(before.causes[0]?.reminder?.kind).toBe("roundCompleted");
      const acknowledged = Promise.withResolvers<SyncCursor>();
      const detail = await f.connect("tablet", { acknowledged: acknowledged.resolve });
      const detailView = await detail.client.open(before.summary.threadId, null);
      await detailView.receipt;
      const verified = await within(acknowledged.promise, 5000, "verified thread detail");
      expect(
        await detail.client.rpc("thread.markRead", {
          threadId: reviewId,
          subscriptionId: detailView.sub.state.request.payload.subscriptionId,
          cursor: verified,
        }),
      ).toMatchObject({ kind: "accepted" });
      const read = await cli(f);
      await compare(read);
      expect(row(read, reviewId)).toMatchObject({
        state: "ready",
        activity: [{ readThrough: verified.through }],
      });
      const original = row(read, reviewId).activity[0]!.rounds[0]!;
      await f.seed(
        activity(
          reviewId,
          44,
          { ...phase, endTimeEvidence: { ...phase.endTimeEvidence, environmentObservedAt: 999 } },
          "2",
        ).filter((item) => item.objectType === "round"),
      );
      const replayed = await cli(f);
      await compare(replayed);
      expect(row(replayed, reviewId).activity[0]!.rounds[0]).toEqual(original);
      const target = { environmentId: f.pairing.identity.id, threadId: before.summary.threadId };
      const returned = {
        kind: "handoff.textReturned",
        version: "1",
        result: {
          kind: "textReturned",
          transferId: "return",
          source: {
            environmentId: f.pairing.identity.id,
            threadId: f.threadId,
            roundId: "round-plan",
          },
          target,
          text: "Returned text",
          history: { coverage: "complete", missingSources: [], omittedItems: 0 },
          input: {
            messageId: "message-44",
            roundId: "round-44",
            attemptId: "a44",
            deliveryId: "d44",
          },
        },
      };
      await f.control({ returned });
      const after = await cli(f);
      await compare(after);
      expect(after.counts).toEqual(read.counts);
      expect(after.rows.map((r) => [r.summary.threadId, r.causes, r.requests])).toEqual(
        replayed.rows.map((r) => [r.summary.threadId, r.causes, r.requests]),
      );
      const idle = Promise.withResolvers<SyncCursor>();
      const readback = await f.connect("return-target", { installed: idle.resolve });
      await (await readback.client.open(target.threadId, null)).receipt;
      await within(idle.promise, 5000, "returned input installed");
      const event = v.parse(TextReturnedEventSchema, returned);
      expect(returnsForInput(readback.cache.read(), target, event.result.input)).toEqual([event]);
      expect(
        returnsForInput(
          readback.cache.read(),
          { ...target, threadId: f.threadId },
          event.result.input,
        ),
      ).toEqual([]);
    });
  });
}, 90000);

test("3. S-STATE-052 holds the new seal and verifies a displaced unchanged row on its own earlier page", async () => {
  await threadFixture(async (f) => {
    const project = f.pairing.projectId,
      id = (n: number) => "settled-" + String(n).padStart(2, "0");
    await f.seed([
      ...Array.from({ length: 54 }, (_, i) => thread(id(i), i === 28 ? 29 : i)),
      thread("newly-settled"),
      { ...thread("other"), value: { ...thread("other").value, projectId: "not-in-scope" } },
    ]);
    const oldSignal = Promise.withResolvers<SyncCursor>();
    const desk = await f.connect("desktop", { installed: oldSignal.resolve });
    const view = await desk.client.openList(project, null);
    await view.receipt;
    const old = await within(oldSignal.promise, 5000, "first installed"),
      first = installedList(desk.cache.read(), view.sub.state)!;
    const tied = [id(28), id(29)];
    expect(first.threadIds.map(String)).toEqual([
      "newly-settled",
      ...Array.from({ length: 24 }, (_, i) => id(53 - i)),
      ...tied,
    ]);
    const versions = tied.map((t) => row(first, t).summary.version);
    const previous = await within(desk.client.earlier(old), 5000, "earlier first snapshot");
    expect(previous.threads).toHaveLength(25);
    expect(String(previous.next?.threadId)).toBe(id(3));
    expect(earlierPage(desk.cache.read(), old)?.verified).toBe(true);
    await desk.close();
    const writer = await f.connect("editor");
    expect(
      await writer.client.rpc("thread.changeLifecycle", {
        threadId: "newly-settled",
        baseVersion: "1",
        change: { kind: "settle" },
      }),
    ).toMatchObject({ kind: "accepted", result: { kind: "threadChanged" } });
    const start = Promise.withResolvers<SyncCursor>(),
      release = Promise.withResolvers<void>(),
      published = Promise.withResolvers<SyncCursor>();
    const reconnect = await f.connect("desktop", {
      installed: published.resolve,
      holdSeal: async (head) => {
        start.resolve(head);
        await release.promise;
      },
    });
    try {
      const resumed = await reconnect.client.openList(project, old);
      await resumed.receipt;
      const head = await within(start.promise, 5000, "new seal held");
      expect(installedList(reconnect.cache.read(), resumed.sub.state)).toEqual(first);
      const fresh = Promise.withResolvers<SyncCursor>(),
        cold = await f.connect("cold", { installed: fresh.resolve });
      const cv = await cold.client.openList(project, null);
      await cv.receipt;
      expect(await within(fresh.promise, 5000, "cold installed")).toEqual(head);
      release.resolve();
      expect(await within(published.promise, 5000, "resumed installation")).toEqual(head);
      const current = installedList(reconnect.cache.read(), resumed.sub.state)!;
      expect(installedList(cold.cache.read(), cv.sub.state)).toEqual(current);
      expect(current.counts).toEqual({
        active: 0,
        pinned: 0,
        snoozed: 0,
        settled: 55,
        archived: 0,
      });
      expect(current.threadIds.map(String)).toEqual([
        "newly-settled",
        ...Array.from({ length: 24 }, (_, i) => id(53 - i)),
      ]);
      expect(earlierPage(reconnect.cache.read(), head)).toMatchObject({
        verified: false,
        page: { through: old },
      });
      const fetched = await reconnect.client.earlier(head);
      expect(fetched.through).toEqual(head);
      expect(
        fetched.threads.slice(0, 2).map((t) => [String(t.threadId), String(t.version)]),
      ).toEqual(tied.map((t, i) => [t, String(versions[i])]));
      expect(earlierPage(reconnect.cache.read(), fetched.through)?.verified).toBe(true);
      const rest = await reconnect.client.earlier(fetched.through, fetched.next);
      expect([...fetched.threads, ...rest.threads].map((t) => String(t.threadId))).toEqual([
        ...tied,
        ...Array.from({ length: 28 }, (_, i) => id(27 - i)),
      ]);
      expect(rest.next).toBeNull();
      await expect(reconnect.client.earlier(fetched.through, previous.next)).rejects.toThrow(
        "cursorExpired",
      );
    } finally {
      release.resolve();
    }
  });
}, 60000);
