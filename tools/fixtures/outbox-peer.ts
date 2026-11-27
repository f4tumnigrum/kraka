import { realpathSync } from "node:fs";
import * as v from "valibot";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { registerProject, type FirstSendStore } from "@kraka/environment";
import {
  CommandIdSchema,
  PrincipalIdSchema,
  ThreadSchema,
  type ProjectId,
  type ThreadId,
} from "@kraka/protocol";
import { startWriter } from "../../packages/daemon/src/first-send";
import type { openAccessHost } from "../../packages/daemon/src/access";
import { accepted, configureLocalOwner } from "./first-send";
import { fixture } from "./replay-process";
import { seedRound, todoFor, thread, round, choices, native } from "./todo";

export async function outboxPeer(
  dir: string,
  host: Awaited<ReturnType<typeof openAccessHost>>,
  mode: "send" | "reject" | "approval",
  emit: (message: unknown) => void,
) {
  await configureLocalOwner(dir);
  const recording = parseReplayRecording(await Bun.file(fixture).text());
  const adapter = createReplayAdapter(recording),
    invoke = adapter.invoke;
  let releaseReceipt: (() => void) | undefined;
  const deliveries: string[] = [],
    commands: string[] = [];
  let decisions = 0,
    cut = mode === "send",
    offline = false;
  adapter.invoke = ((...args: Parameters<typeof invoke>) => {
    if (args[2].kind === "deliverInput") {
      deliveries.push(args[2].deliveryId);
      emit({ event: "nativeInput", id: args[2].deliveryId });
    }
    return invoke(...args);
  }) as typeof invoke;
  let store!: FirstSendStore, projectId!: ProjectId, threadId!: ThreadId;
  const writer = await startWriter(
    dir,
    { adapter, modelId: recording.modelId, expectedText: recording.expectedText },
    {
      opened(s) {
        store = s;
        if (mode === "approval") {
          seedRound(s);
          projectId = thread.projectId;
          threadId = thread.id;
          const todo = todoFor("approval");
          s.todos.open(todo, {
            ...native,
            attemptId: round.attempt.attemptId,
            approval: { permission: "term.input", choices },
            async send(a) {
              decisions++;
              return a.deliveryId;
            },
          });
        } else {
          const actor = {
            id: v.parse(PrincipalIdSchema, "fixture"),
            environmentId: host.identity.id,
            allows: () => true,
          };
          const project = accepted(
            registerProject({
              actor,
              commandId: v.parse(CommandIdSchema, crypto.randomUUID()),
              environmentId: host.identity.id,
              transaction: s,
              realPath: realpathSync.native(dir),
            }),
            "projectRegistered",
          ).project;
          projectId = project.id;
          if (!project.root) throw Error("Missing registered root");
          const row = v.parse(ThreadSchema, {
            ...thread,
            projectId,
            directory: {
              kind: "projectRoot",
              directoryId: project.root.directoryId,
              generation: project.root.generation,
            },
          });
          threadId = row.id;
          s.db.transaction(() => {
            s.db.run("INSERT INTO threads VALUES(?,?)", [row.id, JSON.stringify(row)]);
            s.sync.record([{ objectType: "thread", value: row }]);
          })();
        }
        host.store.provisionProject(projectId);
        host.store.provisionThread(threadId, projectId);
      },
      threadCommand(m) {
        commands.push(m.commandId);
        return mode === "reject"
          ? { kind: "rejected", commandId: m.commandId, failure: { kind: "invalidState" } }
          : null;
      },
      beforeInputReceipt(request, receipt, deliver) {
        if (receipt.kind !== "accepted" || receipt.result.kind !== "inputScheduled")
          return deliver();
        const row = store.db
          .query<{ position: number }, [string]>("SELECT position FROM receipts WHERE command=?")
          .get(request.commandId);
        if (!row) throw Error("Input receipt was not committed");
        emit({
          event: "commandCommitted",
          commandId: request.commandId,
          messageId: receipt.result.messageId,
          position: row.position,
          dropped: cut,
          epoch: request.connectionId,
        });
        if (cut) {
          cut = false;
          return;
        }
        if (mode === "send") {
          releaseReceipt = deliver;
          return;
        }
        deliver();
      },
      update(m) {
        if (m.kind === "round.started") emit({ event: "started", ...m });
      },
    },
  );
  if (writer.kind !== "ready") throw Error("Writer unavailable");
  return {
    status() {
      return {
        threadId,
        projectId,
        deliveries,
        commands,
        decisions,
        receipts: store.db
          .query(
            "SELECT command,position,data FROM receipts WHERE json_extract(data,'$.result.kind')='inputScheduled'",
          )
          .all(),
      };
    },
    release() {
      if (!releaseReceipt) throw Error("No held receipt");
      releaseReceipt();
      releaseReceipt = undefined;
    },
    network(enabled: boolean) {
      offline = !enabled;
    },
    async openThread(nonce: string) {
      if (offline) return null;
      return writer.openThread(nonce, true);
    },
    close: writer.close,
  };
}
