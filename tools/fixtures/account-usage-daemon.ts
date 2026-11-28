import { createInterface } from "node:readline";
import * as v from "valibot";
import { CredentialBindingSchema, ExecutorInstanceIdSchema } from "@kraka/protocol";
import {
  worktreeWorkerCommand,
  runWorktreeWorker,
  WriterExecutorRegistry,
} from "@kraka/environment";
import { startWriter } from "../../packages/daemon/src/first-send";
import { CaseQuotaClock } from "./quota-clock";

const state = process.argv[2];
if (state === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}
if (!state) throw Error("Expected a case state directory");
const clock = new CaseQuotaClock();
const emit = (message: unknown) => console.log(JSON.stringify(message));
const writer = await startWriter(state, null, {
  quota: { clock, signal: emit },
  usageCommitted: (thread, round) => emit({ kind: "usageCommitted", thread, round }),
  opened(store) {
    const registry = new WriterExecutorRegistry(store);
    for (const id of ["A", "B"])
      for (const version of ["1", "2"]) {
        registry.storeSecret(
          v.parse(ExecutorInstanceIdSchema, id),
          v.parse(CredentialBindingSchema, {
            ownerId: "first-send-local-owner",
            namespace: id,
            key: "synthetic",
            version,
          }),
          version === "1" ? id : id + "-replacement",
        );
      }
  },
});
if (writer.kind !== "ready") throw Error("Expected an owned writer");
emit({ kind: "ready", publication: writer.instance });
try {
  for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
    const cmd = v.parse(v.object({ at: v.number(), token: v.string() }), JSON.parse(line));
    await clock.advanceTo(cmd.at);
    emit({ kind: "advanced", token: cmd.token, counts: writer.quotaCounts() });
  }
} finally {
  await writer.close();
}
