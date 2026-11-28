import * as v from "valibot";
import { startWriter } from "../../packages/daemon/src/first-send";
import { WriterExecutorRegistry, registerProject } from "@kraka/environment";
import {
  CommandIdSchema,
  ExecutorInstanceIdSchema,
  PrincipalIdSchema,
  CredentialBindingSchema,
} from "@kraka/protocol";
import type { LoginClock } from "../../packages/daemon/src/instance-login";
const [state, project, owner, initial] = process.argv.slice(2);
if (!state || !project || !owner || !initial || !process.send)
  throw Error("Expected private fixture IPC");
const send = (message: object) => process.send?.(message);
let now = v.parse(v.pipe(v.number(), v.safeInteger()), Number(initial));
const due = new Map<symbol, { at: number; run: () => Promise<void> }>();
const clock: LoginClock = {
  now: () => now,
  at(at, run) {
    const id = Symbol();
    due.set(id, { at, run });
    return () => {
      due.delete(id);
    };
  },
  handled(flowId, disposition) {
    send({ kind: "callbackHandled", flowId, disposition });
  },
};
let projectId: string | undefined;
const writer = await startWriter(state, null, {
  loginClock: clock,
  opened(store) {
    const registry = new WriterExecutorRegistry(store);
    for (const id of ["A", "B"])
      registry.storeSecret(
        v.parse(ExecutorInstanceIdSchema, id),
        v.parse(CredentialBindingSchema, {
          ownerId: owner,
          namespace: id,
          key: "profile",
          version: "1",
        }),
        "fixture-secret-" + id,
      );
    const environmentId = store.writer.environmentId;
    const r = registerProject({
      environmentId,
      transaction: store,
      realPath: project,
      commandId: v.parse(CommandIdSchema, crypto.randomUUID()),
      actor: { environmentId, id: v.parse(PrincipalIdSchema, owner), allows: () => true },
    });
    if (r.kind !== "accepted" || r.result.kind !== "projectRegistered")
      throw Error("Project registration failed");
    projectId = r.result.project.id;
  },
});
if (writer.kind !== "ready") throw Error("Expected owned daemon");
process.on("message", async (raw) => {
  const msg = v.parse(
    v.variant("kind", [
      v.object({ kind: v.literal("advance"), to: v.number() }),
      v.object({ kind: v.literal("close") }),
    ]),
    raw,
  );
  if (msg.kind === "close") {
    await writer.close();
    process.disconnect?.();
    return;
  }
  if (msg.to < now) throw Error("Clock moved backward");
  now = msg.to;
  for (;;) {
    const ready = [...due].find(([, t]) => t.at <= now);
    if (!ready) break;
    due.delete(ready[0]);
    await ready[1].run();
  }
  send({ kind: "advanced", at: now });
});
send({ kind: "ready", instance: writer.instance, projectId });
