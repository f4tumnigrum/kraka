import * as v from "valibot";
import {
  CommandIdSchema,
  HostInstanceIdSchema,
  PrincipalIdSchema,
  ThreadIdSchema,
  RoundIdSchema,
  RoundSchema,
  MessageSchema,
  ThreadSchema,
  SessionBindingSchema,
  type HistoryRow,
} from "@kraka/protocol";
import {
  openWriter,
  openStore,
  registerProject,
  readThread,
  type FirstSendStore,
  type LocalActor,
} from "@kraka/environment";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
export const tid = v.parse(ThreadIdSchema, "thread-A"),
  rid = v.parse(RoundIdSchema, "round-R");
export const original = v.parse(SessionBindingSchema, {
  threadId: tid,
  attemptId: "source-attempt",
  family: "codex",
  instanceId: "alpha",
  nativeSessionId: "native-alpha",
  epoch: 1,
});
export const command = (s: string) => v.parse(CommandIdSchema, s);
export const input = { text: "  next\nquestion  ", references: [], attachments: [] };
export function seedTransition(store: FirstSendStore, cwd: string, actor: LocalActor) {
  if (readThread(store.db, tid)) return;
  const receipt = registerProject({
    transaction: store,
    actor,
    commandId: command("register"),
    environmentId: actor.environmentId,
    realPath: cwd,
  });
  if (
    receipt.kind !== "accepted" ||
    receipt.result.kind !== "projectRegistered" ||
    !receipt.result.project.root
  )
    throw Error("Missing fixture project");
  const project = receipt.result.project;
  const root = receipt.result.project.root;
  const thread = v.parse(ThreadSchema, {
    id: tid,
    projectId: project.id,
    worktreeId: null,
    title: "A",
    lineage: { kind: "root" },
    version: "1",
    directory: { kind: "projectRoot", directoryId: root.directoryId, generation: root.generation },
  });
  const rows: HistoryRow[] = [{ objectType: "thread", value: thread }];
  for (const [index, roundId, user, assistant, userText, answer] of [
    [1, "first-round", "U1", "old", "  initial\n", "x".repeat(65000)],
    [2, rid, "U2", "A2", "recent\nquestion", "  answer  "],
  ] as const) {
    rows.push({
      objectType: "round",
      value: v.parse(RoundSchema, {
        id: roundId,
        threadId: tid,
        messageId: user,
        place: String(index),
        version: "1",
        attempt: {
          attemptId: index === 2 ? original.attemptId : "first-attempt",
          deliveryId: "d" + index,
          phase: {
            kind: "finished",
            root: { id: "root" + index, sessionId: original.nativeSessionId, beganAt: 1 },
            receipt: null,
            endedAt: 2,
            captureId: "c" + index,
          },
        },
      }),
    });
    for (const [id, text, kind] of [
      [user, userText, "person"],
      [assistant, answer, "executor"],
    ] as const)
      rows.push({
        objectType: "message",
        value: v.parse(MessageSchema, {
          id,
          text,
          threadId: tid,
          roundId,
          version: index === 2 ? "2" : "1",
          references: [],
          attachments:
            id === "U1" ? [{ id: "historic-attachment", kind: "file", version: "1" }] : [],
          author: { kind, id: kind === "person" ? actor.id : "alpha" },
        }),
      });
  }
  store.db.transaction(() => {
    for (const row of rows) {
      const json = JSON.stringify(row.value);
      if (row.objectType === "thread")
        store.db.run("INSERT INTO threads VALUES(?,?)", [row.value.id, json]);
      if (row.objectType === "message")
        store.db.run("INSERT INTO messages VALUES(?,?)", [row.value.id, json]);
      if (row.objectType === "round")
        store.db.run("INSERT INTO rounds VALUES(?,?,'person')", [row.value.id, json]);
      store.sync.record([row]);
    }
    store.db.run("INSERT INTO codex_bindings VALUES(?,?,?)", [
      tid,
      1,
      JSON.stringify({ ...original, context: "alpha-context" }),
    ]);
  })();
}
export async function withTransitionStore<T>(
  run: (store: FirstSendStore, actor: LocalActor) => Promise<T>,
) {
  const dir = await mkdtemp(join(tmpdir(), "kraka-s33-"));
  try {
    const lease = await openWriter(
      dir,
      v.parse(HostInstanceIdSchema, crypto.randomUUID()),
      performance.now() + 5000,
    );
    if (lease.kind !== "writer") throw Error("Missing fixture writer");
    try {
      const store = openStore(lease.lease);
      try {
        const actor = {
          id: v.parse(PrincipalIdSchema, "owner"),
          environmentId: store.writer.environmentId,
          allows: () => true,
        };
        seedTransition(store, dir, actor);
        return await run(store, actor);
      } finally {
        store.db.close(true);
      }
    } finally {
      lease.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}
