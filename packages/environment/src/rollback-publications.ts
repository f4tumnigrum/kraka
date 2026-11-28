import type { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  AttemptIdSchema,
  ForgeRepositorySchema,
  type RollbackProgress,
  type Thread,
  type RoundId,
  type PrincipalId,
} from "@kraka/protocol";
import { PublicationBookSchema, sameForgeRepository } from "./forge";
import type { LocalActor } from "./command-receipts";

export const publicationTables = `
CREATE TABLE IF NOT EXISTS publication_books (operation TEXT PRIMARY KEY, book TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS publication_step_history (environment TEXT NOT NULL, thread TEXT NOT NULL, round TEXT NOT NULL, operation TEXT NOT NULL, attempt TEXT NOT NULL, step TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(operation,attempt,step));
CREATE INDEX IF NOT EXISTS publication_round ON publication_step_history(environment,thread,round);
CREATE TABLE IF NOT EXISTS publication_repository_readers (principal TEXT NOT NULL,project TEXT NOT NULL,repository TEXT NOT NULL,PRIMARY KEY(principal,project,repository));
`;
type Effect = NonNullable<RollbackProgress["externalEffects"]>[number];
export function publicationEffects(
  db: Database,
  environment: string,
  thread: Thread,
  rounds: readonly RoundId[],
): Effect[] {
  const rows = db
    .query<
      { book: string; operation: string; attempt: string; step: string; proof: string },
      [string, string, string]
    >(
      `SELECT b.book,h.operation,h.attempt,h.step,h.proof FROM publication_step_history h JOIN publication_books b ON b.operation=h.operation
    WHERE h.environment=? AND h.thread=? AND h.round IN (SELECT value FROM json_each(?)) ORDER BY h.operation,h.attempt,h.step`,
    )
    .all(environment, thread.id, JSON.stringify(rounds));
  return rows.flatMap((row) => {
    const book = v.parse(PublicationBookSchema, JSON.parse(row.book));
    const { request, steps, commandId } = book.progress;
    if (
      commandId !== row.operation ||
      request.projectId !== thread.projectId ||
      request.threadId !== thread.id
    )
      return [];
    const step = Object.values(steps).find((s) => s.kind === "done" && s.proof.step === row.step);
    if (step?.kind !== "done" || !Bun.deepEquals(step.proof, JSON.parse(row.proof))) return [];
    return [
      {
        operationId: commandId,
        attemptId: v.parse(AttemptIdSchema, row.attempt),
        proof: step.proof,
      },
    ];
  });
}
export function visibleEffects(
  db: Database,
  actor: Pick<LocalActor, "id" | "allows">,
  thread: Thread,
  effects: Effect[],
) {
  if (
    !actor.allows("thread.view", { kind: "project", projectId: thread.projectId }) ||
    !actor.allows("thread.view", { kind: "thread", threadId: thread.id })
  )
    return [];
  const grants = db
    .query<{ repository: string }, [PrincipalId, string]>(
      "SELECT repository FROM publication_repository_readers WHERE principal=? AND project=?",
    )
    .all(actor.id, thread.projectId)
    .map((r) => v.parse(ForgeRepositorySchema, JSON.parse(r.repository)));
  return effects.filter(({ proof }) =>
    (proof.step === "pullRequest" ? [proof.source, proof.target] : [proof.branch]).every((b) =>
      grants.some((r) => sameForgeRepository(r, b.repository)),
    ),
  );
}
