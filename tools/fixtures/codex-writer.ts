import { startWriter } from "../../packages/daemon/src/first-send";
import { CredentialBindingSchema, ExecutorInstanceIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import { fixtureActor } from "./first-send-client";
import {
  WriterExecutorRegistry,
  markStartupDetail,
  worktreeWorkerCommand,
  runWorktreeWorker,
} from "@kraka/environment";
if (process.argv[2] === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}
const state = process.argv[2];
if (!state) throw new Error("Missing state directory");
const replies = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
if (process.send)
  process.on("message", (raw) => {
    const r = v.parse(v.object({ token: v.string(), fail: v.boolean() }), raw);
    const pending = replies.get(r.token);
    if (!pending) return;
    replies.delete(r.token);
    if (r.fail) pending.reject(Error("fixtureSummaryFailed"));
    else pending.resolve();
  });
const writer = await startWriter(state, null, {
  ...(process.send
    ? {
        async capture(stage, boundary, s) {
          const token = crypto.randomUUID(),
            done = Promise.withResolvers<void>();
          replies.set(token, done);
          process.send?.({
            stage,
            boundary,
            id: s.key.id,
            thread: s.key.threadId,
            round: s.key.roundId,
            token,
          });
          await done.promise;
        },
      }
    : {}),
  opened(store) {
    const registry = new WriterExecutorRegistry(store);
    markStartupDetail("owner.fixtureRegistry");
    store.db
      .transaction(() => {
        for (const key of ["marker", "replacement"])
          registry.storeSecret(
            v.parse(ExecutorInstanceIdSchema, "codex-test"),
            v.parse(CredentialBindingSchema, {
              ownerId: fixtureActor,
              namespace: "codex-test",
              key,
              version: "1",
            }),
            "fake-private-marker",
          );
      })
      .immediate();
    markStartupDetail("owner.fixtureSecrets");
  },
});
if (writer.kind !== "ready") throw new Error("Expected owned writer");
const close = writer.close;
async function shutdown() {
  await close();
  if (process.connected) process.disconnect?.();
}
process.stdin.once("end", shutdown);
process.stdin.resume();
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
console.log(JSON.stringify({ kind: writer.kind, publication: writer.instance }));
