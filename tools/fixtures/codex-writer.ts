import { startWriter } from "../../packages/daemon/src/first-send";
import { WriterExecutorRegistry } from "@kraka/environment";
import { CredentialBindingSchema, ExecutorInstanceIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import { fixtureActor } from "./first-send-client";
import { worktreeWorkerCommand, runWorktreeWorker } from "@kraka/environment";
if (process.argv[2] === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}
const state = process.argv[2];
if (!state) throw new Error("Missing state directory");
const writer = await startWriter(state, null, {
  opened(store) {
    for (const key of ["marker", "replacement"])
      new WriterExecutorRegistry(store).storeSecret(
        v.parse(ExecutorInstanceIdSchema, "codex-test"),
        v.parse(CredentialBindingSchema, {
          ownerId: fixtureActor,
          namespace: "codex-test",
          key,
          version: "1",
        }),
        "fake-private-marker",
      );
  },
});
if (writer.kind !== "ready") throw new Error("Expected owned writer");
process.stdin.once("end", writer.close);
process.stdin.resume();
process.once("SIGTERM", writer.close);
process.once("SIGINT", writer.close);
console.log(JSON.stringify({ kind: writer.kind, publication: writer.instance }));
