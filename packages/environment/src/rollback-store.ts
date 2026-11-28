import * as v from "valibot";
import {
  ObjectVersionSchema,
  CommandIdSchema,
  DeviceIdSchema,
  DirectoryBindingSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  PrincipalIdSchema,
  RoundIdSchema,
  RollbackProgressSchema,
  type CommandId,
  type DeviceId,
  type RollbackProgress,
  type SignedRequest,
  type ThreadId,
  type CommandReceipt,
  type RoundId,
  type DialogueRollbackTarget,
  type PermissionItem,
} from "@kraka/protocol";
import { REQUEST_METHODS, type RequestResult } from "@kraka/protocol";
import { readThread, readRound, readMessage, type FirstSendStore } from "./first-send-store";
import { recordCommand, reject, type LocalActor } from "./command-receipts";
import { beginRollback, transitionRollback, type RollbackEvent } from "./checkpoints";
import {
  activeRounds,
  affectedRounds,
  overlaps,
  exclusiveCheckout,
  nativeBoundary,
  targetIdentity,
} from "./rollback-target";
import { publicationEffects, visibleEffects } from "./rollback-publications";

type Start = Extract<
  SignedRequest,
  { method: "checkpoint.rollback" | "checkpoint.rollbackDialogue" | "checkpoint.restoreFiles" }
>;
type Retry = Extract<
  SignedRequest,
  { method: "checkpoint.retryDialogue" | "checkpoint.retryFiles" }
>;
const nativeSchema = v.strictObject({
  session: NativeSessionIdSchema,
  context: v.string(),
  roots: v.array(NativeRootTurnIdSchema),
  keep: v.number(),
});
export type RollbackNative = v.InferOutput<typeof nativeSchema>;
const operationSchema = v.strictObject({
  actor: PrincipalIdSchema,
  device: DeviceIdSchema,
  retryActor: v.optional(v.strictObject({ id: PrincipalIdSchema, device: DeviceIdSchema })),
  progress: RollbackProgressSchema,
  binding: v.nullable(DirectoryBindingSchema),
  rounds: v.array(RoundIdSchema),
  native: v.nullable(nativeSchema),
});
export type RollbackOperation = v.InferOutput<typeof operationSchema>;
export type RollbackActor = LocalActor & { device: DeviceId };
export type RollbackMode = "dialogue" | "files" | "both";
export const rollbackTables = `CREATE TABLE IF NOT EXISTS rollback_operations (id TEXT PRIMARY KEY, thread TEXT NOT NULL, unfinished INTEGER NOT NULL, changed TEXT NOT NULL, data TEXT NOT NULL, plan TEXT);
CREATE INDEX IF NOT EXISTS rollback_unfinished ON rollback_operations(id) WHERE unfinished=1;
CREATE INDEX IF NOT EXISTS rollback_thread ON rollback_operations(thread);`;
function modeFor(req: Start): RollbackMode {
  return req.method === "checkpoint.rollback"
    ? "both"
    : req.method === "checkpoint.restoreFiles"
      ? "files"
      : "dialogue";
}
const methods = {
  dialogue: REQUEST_METHODS.rollbackDialogue,
  files: REQUEST_METHODS.restoreFiles,
  both: REQUEST_METHODS.rollbackBoth,
};
export class RollbackOperationStore {
  constructor(readonly store: FirstSendStore) {}
  readonly active = new Map<CommandId, Promise<void>>();
  runtime?: {
    support(target: DialogueRollbackTarget): "verified" | "unsupported" | "unknown";
    allowed(op: RollbackOperation, permission: PermissionItem): boolean;
    rewind(op: RollbackOperation, recovery: boolean): Promise<"succeeded" | "failed" | "unknown">;
  };
  dialogueCommitted?: (id: CommandId, execution: number) => Promise<void>;
  pathWrite?: (id: CommandId, path: string) => void;
  read(id: CommandId) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM rollback_operations WHERE id=?")
      .get(id);
    return row ? v.parse(operationSchema, JSON.parse(row.data)) : null;
  }
  unfinished() {
    return this.store.db
      .query<{ id: string }, []>("SELECT id FROM rollback_operations WHERE unfinished=1")
      .all()
      .map((r) => v.parse(CommandIdSchema, r.id));
  }
  reserves(path: string | null, threadId?: ThreadId) {
    for (const id of this.unfinished()) {
      const op = this.read(id);
      if (!op) continue;
      if (op.progress.target.threadId === threadId) return true;
      if (op.progress.files.kind !== "running" && op.progress.files.kind !== "pending") continue;
      const thread = readThread(this.store.db, op.progress.target.threadId);
      const current = thread && this.store.directory(thread);
      if (!current || (path && overlaps(current, path))) return true;
    }
    return false;
  }
  save(op: RollbackOperation) {
    const { progress } = op,
      { dialogue, files } = progress;
    const unfinished =
      [dialogue, files].some((p) => p.kind === "running") ||
      (dialogue.kind === "pending" &&
        (files.kind === "pending" || files.kind === "notRequested")) ||
      (files.kind === "pending" &&
        (dialogue.kind === "notRequested" || dialogue.kind === "succeeded"));
    const changed = this.store.sync.advanceClock();
    this.store.db.run(
      `INSERT INTO rollback_operations(id,thread,unfinished,changed,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET unfinished=excluded.unfinished,changed=excluded.changed,data=excluded.data`,
      [
        progress.commandId,
        progress.target.threadId,
        Number(unfinished),
        changed,
        JSON.stringify(op),
      ],
    );
    this.store.sync.notify();
  }
  identity(op: RollbackOperation) {
    const resolved = targetIdentity(this.store, op.progress.target);
    return resolved && Bun.deepEquals(resolved.binding, op.binding) ? resolved : null;
  }
  report(expected: RollbackOperation, event: RollbackEvent) {
    return this.store.db
      .transaction(() => {
        const op = this.read(event.commandId);
        if (
          !op ||
          expected.progress.commandId !== event.commandId ||
          !Bun.deepEquals(op.progress.target, expected.progress.target) ||
          !Bun.deepEquals(op.binding, expected.binding) ||
          !this.identity(op)
        )
          return null;
        if (
          event.kind === "claim" &&
          event.part === "files" &&
          event.exclusive &&
          op.progress.dialogue.kind !== "succeeded" &&
          op.progress.dialogue.kind !== "notRequested"
        )
          return null;
        const next = transitionRollback(op.progress, event);
        if (next.kind !== "ok") return null;
        if (Bun.deepEquals(op.progress, next.value)) return op;
        if (event.part === "dialogue" && next.value.dialogue.kind === "succeeded") {
          for (const id of op.rounds) {
            const round = readRound(this.store.db, id);
            if (!round || round.threadId !== op.progress.target.threadId || round.rolledBackBy)
              continue;
            const updated = {
              ...round,
              rolledBackBy: event.commandId,
              version: v.parse(ObjectVersionSchema, String(BigInt(round.version) + 1n)),
            };
            this.store.db.run("UPDATE rounds SET data=? WHERE id=?", [JSON.stringify(updated), id]);
            this.store.sync.record([{ objectType: "round", value: updated }]);
          }
        }
        const updated = { ...op, progress: next.value };
        this.save(updated);
        return updated;
      })
      .immediate();
  }
  preview(actor: RollbackActor, target: DialogueRollbackTarget, mode: RollbackMode) {
    const identity = targetIdentity(this.store, target),
      thread = { kind: "thread", threadId: target.threadId } as const;
    const rewind = this.runtime?.support(target) ?? "unknown";
    const method = methods[mode];
    const maySubmit =
      !!identity &&
      !identity.round.rolledBackBy &&
      [method.permission, ...method.additionalPermissions].every((p) => actor.allows(p, thread)) &&
      (mode === "files" || (rewind === "verified" && !!nativeBoundary(this.store, target))) &&
      (mode === "dialogue" ||
        (identity.capture?.result.kind === "ready" &&
          !!identity.capture.result.comparison &&
          exclusiveCheckout(this.store, identity.thread)));
    return {
      kind: "rollbackPreview",
      rewind,
      restoreFiles: mode !== "dialogue",
      maySubmit,
    } as const;
  }
  project(actor: Pick<LocalActor, "id" | "allows">, op: RollbackOperation) {
    const progress = op.progress;
    if (progress.externalEffects === undefined) return progress;
    const thread = readThread(this.store.db, progress.target.threadId);
    return {
      ...progress,
      externalEffects: thread
        ? visibleEffects(this.store.db, actor, thread, progress.externalEffects)
        : [],
    };
  }
  readRollbackPart({
    actor,
    threadId,
    operationId,
    part,
    commandId = operationId,
  }: {
    actor: RollbackActor;
    threadId: ThreadId;
    operationId: CommandId;
    part: "dialogue" | "files";
    commandId?: CommandId;
  }): CommandReceipt {
    const thread = readThread(this.store.db, threadId);
    if (!thread || !actor.allows("thread.view", { kind: "thread", threadId }))
      return reject(commandId, "notFound");
    const op = this.read(operationId);
    if (op?.progress.target.threadId !== threadId) return reject(commandId, "notFound");
    const message =
      part === "dialogue" &&
      op.progress.dialogue.kind === "succeeded" &&
      op.device === actor.device &&
      op.actor === actor.id
        ? readRound(this.store.db, op.progress.target.roundId)
        : null;
    const draft = message && readMessage(this.store.db, message.messageId);
    return {
      kind: "accepted",
      commandId,
      result: {
        kind: "checkpointRollback",
        progress: this.project(actor, op),
        ...(draft
          ? {
              draft: {
                text: draft.text,
                references: draft.references,
                attachments: draft.attachments,
              },
            }
          : {}),
      },
    };
  }
  private receipt(actor: RollbackActor, r: CommandReceipt): CommandReceipt {
    if (r.kind !== "accepted" || r.result.kind !== "checkpointRollback") return r;
    const progress = r.result.progress,
      thread = readThread(this.store.db, progress.target.threadId);
    return {
      ...r,
      result: {
        ...r.result,
        progress: {
          ...progress,
          ...(progress.externalEffects
            ? {
                externalEffects: thread
                  ? visibleEffects(this.store.db, actor, thread, progress.externalEffects)
                  : [],
              }
            : {}),
        },
      },
    };
  }
  startRollback({ actor, request }: { actor: RollbackActor; request: Start }): CommandReceipt {
    const { commandId, payload: target } = request,
      mode = modeFor(request),
      method = methods[mode];
    const receipt = recordCommand(
      { actor, commandId, transaction: this.store },
      method,
      target,
      { kind: "thread", threadId: target.threadId },
      (): RequestResult | CommandReceipt => {
        if (this.read(commandId)) return reject(commandId, "idConflict");
        if (mode === "dialogue") {
          const round = readRound(this.store.db, target.roundId);
          if (
            !round ||
            round.threadId !== target.threadId ||
            round.attempt.attemptId !== target.attemptId
          )
            return reject(commandId, "notFound");
          if ("nativeSessionId" in target) {
            const phase = round.attempt.phase;
            if (
              !("root" in phase) ||
              phase.root.id !== target.nativeRootTurnId ||
              phase.root.sessionId !== target.nativeSessionId
            )
              return reject(commandId, "invalidState");
            if (this.runtime?.support(target) === "unsupported")
              return reject(commandId, "unsupported");
          }
        }
        const resolved = targetIdentity(this.store, target);
        if (!resolved || resolved.round.rolledBackBy) return reject(commandId, "invalidState");
        if (
          this.store.db
            .query("SELECT 1 FROM rollback_operations WHERE thread=? AND unfinished=1")
            .get(target.threadId)
        )
          return reject(commandId, "invalidState");
        const native = mode === "files" ? null : nativeBoundary(this.store, target);
        if (mode !== "files" && (!native || this.runtime?.support(target) !== "verified"))
          return reject(commandId, "unsupported");
        const rounds = affectedRounds(activeRounds(this.store, target.threadId), target).map(
          (r) => r.id,
        );
        const progress =
          "captureId" in target
            ? beginRollback(commandId, target, mode)
            : beginRollback(commandId, target, "dialogue");
        progress.externalEffects = publicationEffects(
          this.store.db,
          actor.environmentId,
          resolved.thread,
          rounds,
        );
        const op = {
          actor: actor.id,
          device: actor.device,
          binding: resolved.binding,
          progress,
          rounds,
          native: native
            ? {
                session: native.binding.nativeSessionId,
                context: native.binding.context,
                roots: native.roots,
                keep: native.keep,
              }
            : null,
        };
        if (mode !== "dialogue" && resolved.capture) {
          const check = transitionRollback(progress, {
            kind: "claim",
            part: "files",
            commandId,
            execution: 1,
            capture: resolved.capture,
            exclusive: exclusiveCheckout(this.store, resolved.thread),
          });
          if (check.kind !== "ok") return reject(commandId, "invalidState");
          if (check.value.files.kind === "failed") op.progress = check.value;
        }
        this.save(op);
        return { kind: "checkpointRollback", progress: op.progress };
      },
      [...method.additionalPermissions],
    );
    return this.receipt(actor, receipt);
  }
  retry(actor: RollbackActor, req: Retry): CommandReceipt {
    const { commandId, payload } = req,
      part = req.method === "checkpoint.retryFiles" ? "files" : "dialogue";
    const method =
      part === "files" ? REQUEST_METHODS.retryRollbackFiles : REQUEST_METHODS.retryRollbackDialogue;
    const receipt = recordCommand(
      { actor, commandId, transaction: this.store },
      method,
      payload,
      { kind: "thread", threadId: payload.threadId },
      () => {
        const op = this.read(payload.operationId);
        if (op?.progress.target.threadId !== payload.threadId) return reject(commandId, "notFound");
        if (
          !this.identity(op) ||
          (op.progress.dialogue.kind === "pending" &&
            !actor.allows("thread.send", { kind: "thread", threadId: payload.threadId }))
        )
          return reject(commandId, "invalidState");
        const changed = this.report(op, {
          commandId: payload.operationId,
          kind: "retry",
          part,
          execution: payload.expectedExecution,
        });
        if (!changed) return reject(commandId, "invalidState");
        this.store.db.run(
          "UPDATE rollback_operations SET data=json_set(data,'$.retryActor',json(?)) WHERE id=?",
          [JSON.stringify({ id: actor.id, device: actor.device }), payload.operationId],
        );
        if (part === "files")
          this.store.db.run("UPDATE rollback_operations SET plan=NULL WHERE id=?", [
            payload.operationId,
          ]);
        return { kind: "checkpointRollback", progress: changed.progress };
      },
    );
    return this.receipt(actor, receipt);
  }
}
