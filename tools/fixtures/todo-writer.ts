import { join } from "node:path";
import { appendFileSync } from "node:fs";
import * as v from "valibot";
import {
  TodoRequestSchema,
  TodoReplyContentSchema,
  TodoAnswerSchema,
  type DeliveryId,
  CommandIdSchema,
  PrincipalIdSchema,
} from "@kraka/protocol";
import { readReceipt, type FirstSendStore } from "@kraka/environment";
import { startWriter } from "../../packages/daemon/src/first-send";
import { seedRound, round, todoFor, choices, native } from "./todo";
import { terminate } from "./replay-process";

const [mode, dir, kind] = process.argv.slice(2);
if (!dir || !mode || !kind || !process.send) throw Error("Missing private fixture channel");
const emit = process.send.bind(process);
const todo = todoFor(kind);
const route = todo.state.kind === "open" && todo.state.route;
if (!route || route.kind !== "live") throw Error("Missing route");
const delivery = v.object({
  answer: TodoAnswerSchema,
  content: v.nullable(TodoReplyContentSchema),
  requestId: v.literal(route.requestId),
  sessionId: v.literal(route.sessionId),
});
if (mode === "peer") {
  let last: v.InferOutput<typeof delivery> | undefined;
  process.on("disconnect", () => process.exit(0));
  process.on("message", (raw: unknown) => {
    if (raw === "ack") {
      if (!last) throw Error("No matching callback");
      emit({ event: "received", ...last });
    } else {
      last = v.parse(delivery, raw);
      appendFileSync(join(dir, "native-writes.jsonl"), JSON.stringify(last) + "\n");
      emit({ event: "written", ...last });
    }
  });
  emit({ event: "offered", todo });
} else {
  let store: FirstSendStore;
  const pending: { id: string; proceed: () => void }[] = [];
  let stopPeer: () => Promise<void> = async () => {},
    acknowledge = () => {};
  let opened = Promise.resolve();
  const writer = await startWriter(dir, null, {
    opened(s) {
      store = s;
      if (mode === "reopen") return;
      seedRound(s);
      const written = Promise.withResolvers<DeliveryId>();
      void written.promise.catch(() => {});
      const offered = Promise.withResolvers<void>();
      opened = offered.promise;
      let live: ReturnType<typeof s.todos.open> | undefined;
      const peer = Bun.spawn([process.execPath, import.meta.filename, "peer", dir, kind], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "inherit",
        ipc(raw: unknown) {
          const { event } = v.parse(v.object({ event: v.string() }), raw);
          if (event === "offered") {
            const request = v.parse(v.object({ todo: TodoRequestSchema }), raw).todo;
            live = s.todos.open(request, {
              ...native,
              attemptId: round.attempt.attemptId,
              ...(kind === "approval" ? { approval: { permission: "term.input", choices } } : {}),
              async send(answer, content) {
                peer.send({
                  answer,
                  content,
                  requestId: route.requestId,
                  sessionId: route.sessionId,
                });
                return written.promise;
              },
            });
            offered.resolve();
          } else {
            const m = v.parse(delivery, raw);
            if (event === "written") {
              written.resolve(m.answer.deliveryId);
              emit({ event, ...m });
            } else if (event === "received") {
              live?.evidence({
                kind: "received",
                attemptId: m.answer.attemptId,
                deliveryId: m.answer.deliveryId,
                proof: { requestId: m.requestId, sessionId: m.sessionId },
              });
            }
          }
        },
      });
      void peer.exited.then(() => {
        written.reject(Error("Native callback closed"));
        offered.reject(Error("Peer closed before offer"));
        live?.close();
        emit({ event: "joined" });
      });
      acknowledge = () => peer.send("ack");
      stopPeer = () => terminate(peer);
    },
    beforeTodo(id, proceed) {
      pending.push({ id, proceed });
      emit({ event: "queued", id });
    },
  });
  if (writer.kind !== "ready") throw Error("Writer unavailable");
  let closing: Promise<void> | undefined;
  const stop = () =>
    (closing ??= (async () => {
      await stopPeer();
      await writer.close();
      process.disconnect?.();
    })());
  process.on("disconnect", () => void stop());
  process.on("SIGTERM", () => void stop());
  process.on("message", (raw: unknown) => {
    if (raw === "release") {
      for (const p of pending.splice(0)) p.proceed();
    } else if (raw === "ack") acknowledge();
    else if (raw === "disconnect") void stopPeer();
    else if (raw === "stop") void stop();
    else {
      const { actor, id } = v.parse(
        v.object({ actor: PrincipalIdSchema, id: CommandIdSchema }),
        raw,
      );
      const r = readReceipt(store.db, actor, id);
      emit({ event: "position", id, position: r?.position });
    }
  });
  await opened;
  emit({ event: "ready", endpoint: writer.instance.endpoint });
}
