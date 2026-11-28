import * as v from "valibot";
import { startWriter } from "../../packages/daemon/src/first-send";
import {
  worktreeWorkerCommand,
  runWorktreeWorker,
  prepareChildResultTransfer,
  type FirstSendStore,
} from "@kraka/environment";
import {
  AttemptIdSchema,
  ChildResultTransferIdSchema,
  ChildTaskIdSchema,
  MessageIdSchema,
  ProjectIdSchema,
  ExecutorInstanceIdSchema,
} from "@kraka/protocol";
import { toolFamily, nativeEvent } from "./executor-tool-family";
if (process.argv[2] === worktreeWorkerCommand) {
  await runWorktreeWorker(process.argv[3]);
  process.exit(0);
}
const [dir, stop, hold] = process.argv.slice(2);
if (!dir || !process.send) throw Error("Expected private writer");
const publish = process.send.bind(process);
const recovery = Promise.withResolvers<void>();
const barrier = Promise.withResolvers<void>();
let store: FirstSendStore;
const family = await toolFamily(publish);
const writer = await startWriter(dir, null, {
  executorFamilies: [family],
  opened(s) {
    store = s;
    s.services.childTransfers.afterCommit = async (event) => {
      publish({ event: event.kind, ...event });
      if (event.kind === stop) await barrier.promise;
    };
    if (hold === "hold") s.services.childTransfers.beforeRecovery = () => recovery.promise;
  },
});
if (writer.kind !== "ready") throw Error("Expected owned writer");
publish({ event: "ready", publication: writer.instance });
const control = v.variant("action", [
  v.object({
    action: v.picklist(["question", "approval", "finish"]),
    attempt: AttemptIdSchema,
    text: v.string(),
  }),
  v.object({ action: v.picklist(["release", "fence", "close"]) }),
  v.object({
    action: v.literal("default"),
    project: ProjectIdSchema,
    instance: ExecutorInstanceIdSchema,
  }),
  v.object({ action: v.literal("replay"), taskId: ChildTaskIdSchema }),
  v.object({ action: v.literal("return"), transferId: ChildResultTransferIdSchema }),
  v.object({ action: v.literal("conflict"), transferId: ChildResultTransferIdSchema }),
]);
process.on("message", async (raw) => {
  const { id } = v.parse(v.object({ id: v.string() }), raw);
  try {
    const msg = v.parse(control, raw);
    let result: unknown = true;
    switch (msg.action) {
      case "question":
      case "approval":
      case "finish":
        nativeEvent(msg.attempt, msg.action, msg.text);
        break;
      case "release":
        recovery.resolve();
        break;
      case "fence":
        break;
      case "default":
        store.db.run("UPDATE project_executor_defaults SET instance=? WHERE project=?", [
          msg.instance,
          msg.project,
        ]);
        break;
      case "replay": {
        const r = await store.services.childTransfers.read(msg.taskId);
        if (!r) throw Error("Missing child");
        const t = prepareChildResultTransfer(r);
        if (t.kind !== "ok") throw Error("Missing completion");
        result = await store.services.childTransfers.settle(r, t.value);
        break;
      }
      case "conflict": {
        const t = await store.services.childTransfers.readTransfer(msg.transferId);
        if (!t) throw Error("Missing transfer");
        result = await store.services.childTransfers.markReturned(
          t.id,
          v.parse(MessageIdSchema, "conflict"),
          0,
          t.version,
        );
        break;
      }
      case "return":
        result = await store.services.childTransfers.returnToParent(msg.transferId);
        break;
      case "close":
        recovery.resolve();
        barrier.resolve();
        await writer.close();
        break;
    }
    publish({ event: "ack", id, result });
    if (msg.action === "close") process.disconnect?.();
  } catch (e) {
    publish({ event: "error", id, reason: e instanceof Error ? e.message : "fixture failure" });
  }
});
process.on("disconnect", () => process.exit(0));
