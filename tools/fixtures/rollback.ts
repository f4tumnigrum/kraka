import { Database } from "bun:sqlite";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CommandId, RollbackProgress } from "@kraka/protocol";
import { accepted } from "./first-send";
import { git } from "./isolated-start";
import { address, finished, type PatchHost } from "./round-patch";
import { commandId } from "./paired-project";
export async function twoTurns(s: PatchHost) {
  console.log(
    "Rollback runner",
    process.env.ImageOS ?? process.platform,
    process.env.ImageVersion ?? "local",
    git(s.f.cwd, "--version"),
  );
  writeFileSync(join(s.state, "rollback-native-ledger"), join(s.dir, "peer.jsonl"));
  const file = join(s.f.cwd, "version.txt");
  writeFileSync(file, "first saved");
  git(s.f.cwd, "add", "version.txt");
  git(s.f.cwd, "commit", "-qm", "Second fixture commit");
  const first = await s.start("first prompt");
  const reader = await s.patchReader(first.threadId);
  s.action(first.turn.handle, "finish");
  await finished(reader, first.roundId);
  const since = s.events.items.length;
  const next = accepted(
    (await s.input(first.threadId, "selected prompt")).receipt,
    "inputScheduled",
  );
  const turn = await s.event("turn", since);
  writeFileSync(file, "second saved");
  s.action(turn.handle, "finish");
  const { round, capture } = await finished(reader, next.roundId);
  assert.equal(capture.result.kind, "ready");
  const target = {
    ...address(s, first.threadId),
    roundId: round.id,
    attemptId: round.attempt.attemptId,
    captureId: capture.id,
    boundary: "before",
  } as const;
  const attachments = [{ kind: "file", id: "original-file", version: "1" }];
  await s.f.stop();
  const db = new Database(join(s.state, "environment.sqlite"));
  try {
    db.run("UPDATE messages SET data=json_set(data,'$.attachments',json(?)) WHERE id=?", [
      JSON.stringify(attachments),
      round.messageId,
    ]);
    db.run(
      "UPDATE sync_rows SET payload=json_set(payload,'$.value.attachments',json(?)) WHERE source=? AND key=?",
      [JSON.stringify(attachments), first.threadId, JSON.stringify(["message", round.messageId])],
    );
  } finally {
    db.close(true);
  }
  return { round, first, target, file, attachments, id: commandId(), threadId: first.threadId };
}
export type Seed = Awaited<ReturnType<typeof twoTurns>>;
export async function resume(s: PatchHost, enabled = true) {
  if (enabled) writeFileSync(join(s.dir, "rewind-enabled"), "");
  await s.restartRollback();
  if (!enabled) return;
  accepted(
    (
      await s.client.send("executor.refresh", {
        projectId: s.f.project.id,
        instanceId: s.f.registration.instanceId,
      })
    ).receipt,
    "executorRefreshed",
  );
}
export type Reader = Awaited<ReturnType<PatchHost["rollbackReader"]>>;
export function readPart(
  client: Reader,
  seed: Pick<Seed, "id" | "threadId">,
  part: "dialogue" | "files",
) {
  return client
    .rpc("checkpoint.readRollbackPart", { threadId: seed.threadId, operationId: seed.id, part })
    .then((r) => accepted(r, "checkpointRollback"));
}
export function settled(
  client: Reader,
  id: CommandId,
  part: "files" | "dialogue",
  kind: RollbackProgress["files"]["kind"],
  execution = 1,
) {
  return client.states.until(
    (p) =>
      p.commandId === id &&
      p[part].kind === kind &&
      "execution" in p[part] &&
      p[part].execution === execution,
    0,
    12000,
  );
}
export async function ledger(s: PatchHost) {
  const { rewinds, writes } = await s.rollbackFence();
  return { rewinds, writes };
}
