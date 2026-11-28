// Live cases 4; required groups ["1.", "2.", "3."]
// Live shell bash
import { expect, test } from "bun:test";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import * as v from "valibot";
import {
  canonicalJson,
  CommandIdSchema,
  SecretTargetSchema,
  TodoAnswerSchema,
  type TodoState,
  type CommandReceipt,
} from "@kraka/protocol";
import { SqliteThreadCache } from "../../packages/cli-client/src/thread-cache";
import { connectReplica } from "../fixtures/thread-resume";
import { startPairedProject, type Client } from "../fixtures/paired-project";
import { configureLocalOwner } from "../fixtures/first-send";
import { Journal } from "../fixtures/route-network";
import { scenario, thread, round, todoFor, choices, native } from "../fixtures/todo";
import { terminate, within, withState } from "../fixtures/replay-process";

function start(dir: string, mode: string, kind: string) {
  const events = new Journal<Record<string, unknown>>();
  const p = Bun.spawn(
    [process.execPath, join(import.meta.dir, "../fixtures/todo-writer.ts"), mode, dir, kind],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      ipc(raw: unknown) {
        events.push(v.parse(v.record(v.string(), v.unknown()), raw));
      },
    },
  );
  const err = new Response(p.stderr).text();
  void p.exited.then(async () => events.push({ event: "exit", error: await err }));
  return {
    send: (m: unknown) => p.send(m),
    async event(name: string, from = 0) {
      const e = await events
        .until((e) => e.event === name || e.event === "exit", from)
        .catch(() => {
          throw Error("Missing " + name + ": " + events.items.map((e) => e.event).join(","));
        });
      if (e.event === "exit") throw Error("Fixture exited: " + e.error);
      return e;
    },
    events,
    async stop() {
      try {
        if (p.exitCode === null && p.signalCode === null) {
          p.send("stop");
          await within(p.exited, 4000, "Writer shutdown");
        }
      } finally {
        await terminate(p);
      }
    },
  };
}
const ordered = scenario.inputs
  .flatMap((i) => (i.event.kind === "commands" ? i.event.requests : []))
  .filter((r) => r.method === "todo.answer");
async function race(
  kind: "question" | "approval" | "secret",
  mobileFirst: boolean,
  interrupt: boolean,
) {
  return withState(async (dir) => {
    const pair = await startPairedProject({
      stateDir: dir,
      projectId: thread.projectId,
      requests: [["thread.view", "thread.reply", "owner.decide", "term.input"]],
    });
    const host = join(pair.stateDir, "host");
    const caches: SqliteThreadCache[] = [],
      sockets: Awaited<ReturnType<typeof connectReplica>>[] = [];
    let writer: ReturnType<typeof start> | undefined;
    const todo = todoFor(kind);
    const ids = { threadId: thread.id, todoRequestId: todo.id };
    async function connect(endpoint: string, dev: Client, name: string) {
      const cache = new SqliteThreadCache(join(dir, crypto.randomUUID() + ".sqlite"), name);
      caches.push(cache);
      const seals = new Journal<TodoState>();
      const rpcId = v.parse(
        CommandIdSchema,
        name === "desktop" ? ordered[0]!.commandId : ordered[1]!.commandId,
      );
      const socket = await connectReplica(endpoint, pair.identity, dev, cache, {
        minor: 1,
        commandId: (method) =>
          method === "todo.answer" || method === "todo.decide" ? rpcId : crypto.randomUUID(),
        installed() {
          const row = Object.values(cache.read().rows).find(
            (r) => r.row?.objectType === "todoRequest" && r.row.value.id === todo.id,
          )?.row;
          if (row?.objectType === "todoRequest") seals.push(row.value.state);
        },
      });
      sockets.push(socket);
      const sub = await socket.client.open(thread.id, null);
      expect((await sub.receipt).kind).toBe("accepted");
      await seals.until(() => true);
      return { ...socket, name, seals, rpcId, dev };
    }
    try {
      await configureLocalOwner(host);
      writer = start(host, "serve", kind);
      const endpoint = v.parse(v.string(), (await writer.event("ready")).endpoint);
      let desktop = await connect(endpoint, pair.owner, "desktop"),
        mobile = await connect(endpoint, pair.clients[0]!, "tablet");
      const [first, second] = mobileFirst ? [mobile, desktop] : [desktop, mobile];
      expect(first.seals.items[0]?.kind).toBe("open");
      expect(second.seals.items[0]).toEqual(first.seals.items[0]);
      const token = "synthetic-only-9b8240-test";
      const privateId = v.parse(CommandIdSchema, crypto.randomUUID());
      if (kind === "secret") {
        const route = todo.state.kind === "open" && todo.state.route;
        if (!route || route.kind !== "live") throw Error("Missing secret route");
        const target = v.parse(SecretTargetSchema, {
          ...ids,
          environmentId: pair.identity.id,
          projectId: thread.projectId,
          version: todo.version,
          attemptId: round.attempt.attemptId,
          instanceId: native.instanceId,
          sessionId: route.sessionId,
          requestId: route.requestId,
          purpose: { kind: "toolOnce", tool: "lookup" },
        });
        const submit = (value: string) =>
          first.submitSecret({ target, choice: { kind: "value", value } }, privateId);
        const incorrect = await first.submitSecret(
          {
            target: { ...target, purpose: { kind: "toolOnce", tool: "different" } },
            choice: { kind: "value", value: token },
          },
          v.parse(CommandIdSchema, crypto.randomUUID()),
        );
        expect(incorrect).toMatchObject({ failure: { kind: "invalidState" } });
        const saved = await submit(token);
        expect(saved).toMatchObject({ kind: "accepted", result: { kind: "secretReceipt" } });
        expect(await submit(token)).toEqual(saved);
        expect(await submit("different")).toMatchObject({ failure: { kind: "idConflict" } });
      }
      const command = (client: typeof first) => {
        const desktop = client.name === "desktop";
        if (kind === "question")
          return client.client.rpc("todo.answer", ordered[desktop ? 0 : 1]!.payload);
        return client.client.rpc("todo.decide", {
          ...ids,
          decision:
            kind === "approval"
              ? choices[desktop ? 1 : 0]
              : { kind: "secret", receiptCommandId: privateId },
        });
      };
      const submit = async (client: typeof first) => {
        const since = writer!.events.items.length;
        const promise = command(client);
        void promise.catch(() => {});
        const event = await writer!.event("queued", since);
        expect(event.id).toBe(client.rpcId);
        return { promise };
      };
      const a = await submit(first),
        b = await submit(second);
      writer.send("release");
      const [win, lose] = await Promise.all([a.promise, b.promise]);
      expect(win).toMatchObject({
        kind: "accepted",
        result: { kind: "todoAnswerStored", todoRequestId: todo.id },
      });
      if (lose.kind !== "rejected" || lose.failure.kind !== "todoChanged")
        throw Error("Missing authorized loser: " + JSON.stringify(lose));
      const current = lose.failure.current;
      expect(current.id).toBe(todo.id);
      if (current.state.kind !== "answered") throw Error("No winner");
      const answer = current.state.answer;
      expect(answer).toMatchObject({
        authorId: first.principal,
        deviceId: first.dev.device.deviceId,
      });
      for (const client of [first, second])
        await client.seals.until((s) => s.kind === "answered" && s.answer.at === answer.at);
      const written = await writer.event("written");
      expect(v.parse(TodoAnswerSchema, written.answer)).toEqual(answer);
      const position = async (client: typeof first) => {
        const since = writer!.events.items.length;
        writer!.send({ actor: client.principal, id: client.rpcId });
        return Number((await writer!.event("position", since)).position);
      };
      const firstPosition = await position(first);
      expect(firstPosition).toBeGreaterThan(0);
      expect(await position(second)).toBeGreaterThan(firstPosition);
      const retry = await submit(first);
      writer.send("release");
      expect(await retry.promise).toEqual(win);
      expect(await position(first)).toBe(firstPosition);
      if (interrupt) {
        writer.send("disconnect");
        await writer.event("joined");
        await Promise.all(sockets.splice(0).map((c) => c.close()));
        await writer.stop();
        const began = performance.now();
        writer = start(host, "reopen", kind);
        const endpoint = v.parse(v.string(), (await writer.event("ready")).endpoint);
        desktop = await connect(endpoint, pair.owner, "desktop");
        mobile = await connect(endpoint, pair.clients[0]!, "tablet");
        for (const client of [desktop, mobile])
          expect(client.seals.items[0]).toMatchObject({
            kind: "answered",
            answer,
            arrival: { kind: "uncertain", next: "inspectAnswer" },
          });
        console.info(
          JSON.stringify({
            case: "interrupted-answer",
            elapsedMs: performance.now() - began,
            attemptId: answer.attemptId,
            deliveryId: answer.deliveryId,
          }),
        );
      } else {
        writer.send("ack");
        for (const c of [first, second])
          await c.seals.until((s) => s.kind === "answered" && s.arrival.kind === "received");
      }
      const reads: CommandReceipt[] = await Promise.all(
        [desktop, mobile].map((c) => c.client.rpc("todo.readAnswer", ids)),
      );
      if (kind === "secret") {
        expect(answer.content).toEqual({ kind: "secretReceipt", commandId: privateId });
        for (const r of reads)
          expect(r).toMatchObject({ kind: "rejected", failure: { kind: "notFound" } });
        for (const c of [first, second])
          expect(JSON.stringify([c.messages, c.cache.read()])).not.toContain(token);
      } else {
        const content =
          kind === "approval"
            ? choices[mobileFirst ? 0 : 1]
            : { kind: "question", answers: ordered[mobileFirst ? 1 : 0]!.payload.answers };
        expect(written.content).toEqual(content);
        for (const r of reads)
          expect(r).toMatchObject({
            kind: "accepted",
            result: {
              kind: "todoAnswerRead",
              ...("messageId" in answer.content ? { messageId: answer.content.messageId } : {}),
              todoRequestId: todo.id,
              at: answer.at,
              authorId: first.principal,
              deviceId: first.dev.device.deviceId,
              content,
            },
          });
        for (const c of [desktop, mobile]) {
          expect(
            Object.values(c.cache.read().rows).some(
              (r) =>
                r.row?.objectType === "message" &&
                answer.content.kind === "message" &&
                r.row.value.id === answer.content.messageId,
            ),
          ).toBe(true);
        }
      }
      const writes = readFileSync(join(host, "native-writes.jsonl"), "utf8").trim().split("\n");
      expect(writes.length).toBe(1);
      console.info(
        JSON.stringify({
          kind,
          mobileFirst,
          request: todo.id,
          firstPosition,
          decisionAt: answer.at,
          author: first.name,
          authorized: [win.kind, lose.failure.kind],
          deliveryBytes: Buffer.byteLength(writes[0]!),
        }),
      );
    } finally {
      try {
        await Promise.all(sockets.map((c) => c.close()));
      } finally {
        for (const cache of caches) cache.close();
        try {
          await writer?.stop();
        } finally {
          await pair.close();
        }
      }
    }
  });
}
test("1. Both devices install the first keyed answer in fixture order and reversed order", async () => {
  await race("question", false, false);
  await race("question", true, false);
}, 30000);
test(
  "2. Mobile accepts the live approval while the desktop denies it",
  () => race("approval", true, false),
  15000,
);
test(
  "3. A disconnected callback keeps the original winner without a second write",
  () => race("approval", false, true),
  15000,
);
test(
  "Confidential submission stays out of both public transcripts",
  () => race("secret", false, false),
  15000,
);
