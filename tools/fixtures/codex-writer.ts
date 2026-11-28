import { readFileSync, existsSync, appendFileSync } from "node:fs";
import { join } from "node:path";
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
let publicationCalls = () => 0;
const replies = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
if (process.send)
  process.on("message", (raw) => {
    const fence = v.safeParse(
      v.object({ kind: v.literal("rollbackFence"), token: v.string() }),
      raw,
    );
    if (fence.success) {
      const file = join(state, "rollback-writes"),
        native = join(state, "rollback-native-ledger");
      const rows = (path: string) =>
        existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
      const source = readFileSync(native, "utf8");
      const rewinds = rows(source).filter(
        (line) => JSON.parse(line).event === "thread/rollback",
      ).length;
      process.send?.({
        kind: "rollbackFence",
        token: fence.output.token,
        writes: rows(file).length,
        rewinds,
        publications: publicationCalls(),
      });
      return;
    }
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
    publicationCalls = () =>
      Number(
        store.db.query<{ n: number }, []>("SELECT count(*) n FROM fixture_publication_calls").get()
          ?.n,
      );
    store.db.exec("CREATE TABLE IF NOT EXISTS fixture_publication_calls(operation TEXT)");
    for (const table of ["publication_books", "publication_step_history"]) {
      for (const event of ["INSERT", "UPDATE", "DELETE"])
        store.db.exec(
          `CREATE TEMP TRIGGER audit_${table}_${event} AFTER ${event} ON main.${table} BEGIN INSERT INTO fixture_publication_calls VALUES('${event}'); END`,
        );
    }
    store.services.rollbacks.dialogueCommitted = async (id, execution) => {
      if (!existsSync(join(state, "hold-rollback"))) return;
      const token = crypto.randomUUID(),
        done = Promise.withResolvers<void>();
      replies.set(token, done);
      process.send?.({
        stage: "dialogueCommitted",
        boundary: "before",
        thread: "",
        round: String(execution),
        id,
        token,
      });
      await done.promise;
    };
    store.services.rollbacks.pathWrite = (id, path) => {
      appendFileSync(join(state, "rollback-writes"), JSON.stringify({ id, path }) + "\n");
      if (existsSync(join(state, "fail-rollback"))) throw Error("Injected I/O failure");
    };
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
