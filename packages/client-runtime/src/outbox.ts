import { acceptedInput } from "./thread-pass";
import * as v from "valibot";
import {
  canonicalJson,
  CommandIdSchema,
  EnvironmentIdSchema,
  InputContentSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  PrincipalIdSchema,
  RoundIdSchema,
  ThreadIdSchema,
  type CommandReceipt,
  type InputContent,
  type MessageId,
  type SignedRequest,
  type Utf8,
} from "@kraka/protocol";
import type { LocalStateStore, LocalStateMutation, RandomSource } from "./index";
import type { QueueEditDraft } from "./queue-draft";

export interface TransactionalState extends LocalStateStore {
  transact<T>(
    keys: readonly string[],
    change: (values: readonly (Uint8Array | null)[]) => {
      result: T;
      writes: readonly LocalStateMutation[];
    },
  ): Promise<T>;
}
export interface OutboxHost {
  state: TransactionalState;
  random: RandomSource;
  utf8: Utf8;
  now(): number;
  withSender<T>(key: string, work: () => Promise<T>): Promise<T | undefined>;
}
const scopeSchema = v.strictObject({
  principalId: PrincipalIdSchema,
  environmentId: EnvironmentIdSchema,
  threadId: ThreadIdSchema,
});
export type InputScope = v.InferOutput<typeof scopeSchema>;
const uuid = v.pipe(v.string(), v.uuid(), v.regex(/-4[0-9a-f]{3}-[89ab]/i));
const draft = v.strictObject({ revision: uuid, content: InputContentSchema });
export type Draft = v.InferOutput<typeof draft>;
const editBase = {
  environmentId: EnvironmentIdSchema,
  threadId: ThreadIdSchema,
  roundId: RoundIdSchema,
  baseVersion: ObjectVersionSchema,
  content: InputContentSchema,
};
const edit = v.variant("kind", [
  v.strictObject({ ...editBase, kind: v.literal("editing") }),
  v.strictObject({
    ...editBase,
    kind: v.literal("conflict"),
    currentVersion: v.nullable(ObjectVersionSchema),
  }),
]);
const count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const pending = v.strictObject({
  localKey: uuid,
  commandId: v.pipe(uuid, CommandIdSchema),
  content: InputContentSchema,
  order: v.pipe(count, v.minValue(1)),
  progress: v.variant("kind", [
    v.strictObject({ kind: v.literal("queued") }),
    v.strictObject({
      kind: v.literal("sending"),
      attempts: count,
      connectionId: v.string(),
      retryAt: count,
    }),
    v.strictObject({ kind: v.literal("accepted"), messageId: MessageIdSchema }),
  ]),
});
export type PendingInput = v.InferOutput<typeof pending>;
const version = v.literal(1);
const drafts = v.strictObject({
  format: version,
  current: v.nullable(draft),
  returned: v.array(draft),
  edits: v.array(
    v.strictObject({ revision: uuid, commandId: v.pipe(uuid, CommandIdSchema), draft: edit }),
  ),
});
const queue = v.strictObject({ format: version, lastOrder: count, items: v.array(pending) });
const receipts = v.strictObject({ format: version, bindings: v.record(uuid, MessageIdSchema) });
type State = {
  drafts: v.InferOutput<typeof drafts>;
  queue: v.InferOutput<typeof queue>;
  receipts: v.InferOutput<typeof receipts>;
};
type Send = Extract<SignedRequest, { method: "input.send" }>;
export type OrdinaryReceipt = {
  principalId: InputScope["principalId"];
  request: Send;
  receipt: CommandReceipt;
};
export interface OutboxConnection {
  writable(scope: InputScope): string | null;
  send(intent: Pick<Send, "method" | "payload" | "commandId">): Promise<OrdinaryReceipt | null>;
  installed(scope: InputScope, id: MessageId): Promise<boolean>;
}
export function inputScopeKey(scope: InputScope) {
  return JSON.stringify([scope.principalId, scope.environmentId, scope.threadId]);
}
function newId(random: RandomSource) {
  const b = random.bytes(16);
  if (b.length !== 16) throw Error("Invalid random source");
  b[6] = ((b[6] ?? 0) & 15) | 64;
  b[8] = ((b[8] ?? 0) & 63) | 128;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join("-");
}
export class InputOutbox {
  private readonly lastAttempt = new Map<string, string>();
  constructor(private host: OutboxHost) {}
  private change<T>(scope: InputScope, change: (state: State) => T) {
    const suffix = inputScopeKey(v.parse(scopeSchema, scope));
    const names = ["drafts", "queue", "receipts"] as const;
    const keys = names.map((n) => n + "/" + suffix);
    const { utf8 } = this.host;
    return this.host.state.transact(keys, (values) => {
      const parsed = values.map((b) => (b === null ? undefined : JSON.parse(utf8.decode(b))));
      const read = <S extends v.GenericSchema>(schema: S, i: number, initial: v.InferOutput<S>) =>
        parsed[i] === undefined ? initial : v.parse(schema, parsed[i]);
      const state: State = {
        drafts: read(drafts, 0, { format: 1, current: null, returned: [], edits: [] }),
        queue: read(queue, 1, { format: 1, lastOrder: 0, items: [] }),
        receipts: read(receipts, 2, { format: 1, bindings: {} }),
      };
      let previous = 0;
      const ids = new Set<string>();
      for (const item of state.queue.items) {
        if (
          item.order <= previous ||
          item.order > state.queue.lastOrder ||
          ids.has(item.localKey) ||
          ids.has(item.commandId) ||
          item.localKey === String(item.commandId) ||
          Object.hasOwn(state.receipts.bindings, item.commandId)
        )
          throw Error("Invalid outbox index");
        previous = item.order;
        ids.add(item.localKey);
        ids.add(item.commandId);
      }
      const before = names.map((n) => JSON.stringify(state[n]));
      const result = change(state);
      const writes = names.flatMap((n, i) => {
        const value = JSON.stringify(state[n]);
        return value === before[i] ? [] : [{ key: keys[i]!, value: utf8.encode(value) }];
      });
      return { writes, result };
    });
  }
  inspect(scope: InputScope) {
    return this.change(scope, (s) => s);
  }
  saveDraft(
    scope: InputScope,
    text: string,
    refs: Pick<InputContent, "attachments" | "references"> = { attachments: [], references: [] },
  ) {
    const content = v.parse(InputContentSchema, { ...refs, text });
    return this.change(scope, (s) => {
      const current = { revision: newId(this.host.random), content };
      s.drafts.current = current;
      return current;
    });
  }
  queueInput(scope: InputScope, draftRevision: string) {
    return this.change(scope, (s) => {
      const current = s.drafts.current;
      if (!current || current.revision !== draftRevision) throw Error("Draft changed");
      const item: PendingInput = {
        localKey: newId(this.host.random),
        commandId: v.parse(CommandIdSchema, newId(this.host.random)),
        order: ++s.queue.lastOrder,
        content: current.content,
        progress: { kind: "queued" },
      };
      if (
        !Number.isSafeInteger(item.order) ||
        item.localKey === String(item.commandId) ||
        Object.hasOwn(s.receipts.bindings, item.commandId) ||
        s.queue.items.some((p) => p.commandId === item.commandId || p.localKey === item.localKey)
      )
        throw Error("Cannot allocate pending input");
      s.queue.items.push(item);
      s.drafts.current = null;
      return item;
    });
  }
  recoverReturned(scope: InputScope, revision: string) {
    return this.change(scope, (s) => {
      const index = s.drafts.returned.findIndex((d) => d.revision === revision);
      if (index < 0) throw Error("Returned draft changed");
      const [chosen] = s.drafts.returned.splice(index, 1);
      if (s.drafts.current) s.drafts.returned.push(s.drafts.current);
      if (!chosen) throw Error("Returned draft changed");
      s.drafts.current = chosen;
      return chosen;
    });
  }
  saveQueueEdit(scope: InputScope, value: QueueEditDraft) {
    if (value.environmentId !== scope.environmentId || value.threadId !== scope.threadId)
      throw Error("Wrong edit scope");
    return this.change(scope, (s) => {
      const row = {
        revision: newId(this.host.random),
        commandId: v.parse(CommandIdSchema, newId(this.host.random)),
        draft: v.parse(edit, value),
      };
      s.drafts.edits.push(row);
      return row;
    });
  }
  settleQueueEdit(
    scope: InputScope,
    revision: string,
    command: Extract<SignedRequest, { method: "input.editQueued" }>,
    receipt: CommandReceipt,
  ) {
    return this.change(scope, (s) => {
      const row = s.drafts.edits.find((e) => e.revision === revision);
      if (
        !row ||
        row.draft.kind !== "editing" ||
        command.environmentId !== scope.environmentId ||
        command.commandId !== row.commandId ||
        command.commandId !== receipt.commandId ||
        command.payload.threadId !== scope.threadId ||
        command.payload.roundId !== row.draft.roundId ||
        command.payload.baseVersion !== row.draft.baseVersion ||
        canonicalJson(command.payload.content) !== canonicalJson(row.draft.content)
      )
        return;
      if (
        receipt.kind === "rejected" &&
        receipt.failure.kind === "queueConflict" &&
        receipt.failure.threadId === scope.threadId &&
        receipt.failure.roundId === row.draft.roundId
      )
        row.draft = {
          ...row.draft,
          kind: "conflict",
          currentVersion: receipt.failure.currentVersion,
        };
      else if (
        receipt.kind === "accepted" &&
        receipt.result.kind === "queueUpdated" &&
        receipt.result.update.threadId === scope.threadId &&
        receipt.result.update.change.kind === "edited" &&
        receipt.result.update.change.roundId === row.draft.roundId
      )
        s.drafts.edits = s.drafts.edits.filter((e) => e !== row);
    });
  }
  dismissQueueEdit(scope: InputScope, revision: string) {
    return this.change(scope, (s) => {
      s.drafts.edits = s.drafts.edits.filter((e) => e.revision !== revision);
    });
  }
  reconcileReceipt(scope: InputScope, evidence: OrdinaryReceipt) {
    return this.change(scope, (s) => {
      const { request, receipt } = evidence;
      const p = s.queue.items.find((i) => i.commandId === receipt.commandId);
      if (
        !p ||
        p.progress.kind !== "sending" ||
        request.method !== "input.send" ||
        scope.principalId !== evidence.principalId ||
        request.environmentId !== scope.environmentId ||
        request.commandId !== p.commandId ||
        request.payload.threadId !== scope.threadId ||
        canonicalJson(request.payload.content) !== canonicalJson(p.content)
      )
        return;
      const accepted = acceptedInput(request, receipt);
      if (accepted) {
        p.progress = { kind: "accepted", messageId: accepted.messageId };
      } else if (receipt.kind === "rejected") {
        const d = { revision: newId(this.host.random), content: p.content };
        if (s.drafts.current) s.drafts.returned.push(d);
        else s.drafts.current = d;
        s.queue.items = s.queue.items.filter((i) => i !== p);
      }
    });
  }
  async reflectInstalled(scope: InputScope, installed: OutboxConnection["installed"]) {
    const { queue } = await this.inspect(scope);
    for (const item of queue.items) {
      const progress = item.progress;
      if (progress.kind !== "accepted" || !(await installed(scope, progress.messageId))) continue;
      await this.change(scope, (s) => {
        const index = s.queue.items.findIndex(
          (i) =>
            i.commandId === item.commandId &&
            i.progress.kind === "accepted" &&
            i.progress.messageId === progress.messageId,
        );
        if (index < 0) return;
        s.receipts.bindings[item.commandId] = progress.messageId;
        s.queue.items.splice(index, 1);
      });
    }
  }
  async flushHead(scope: InputScope, connection: OutboxConnection) {
    const key = inputScopeKey(scope);
    return this.host.withSender(key, async () => {
      await this.reflectInstalled(scope, connection.installed);
      const next = await this.change(scope, (s) => {
        const session = connection.writable(scope);
        if (!session) return { kind: "parked" } as const;
        const head = s.queue.items.find((i) => i.progress.kind !== "accepted");
        if (!head) return { kind: "empty" } as const;
        const prior = head.progress;
        const now = this.host.now();
        if (
          prior.kind === "sending" &&
          (prior.connectionId === session || this.lastAttempt.get(key) === session) &&
          now < prior.retryAt
        )
          return { kind: "retry", after: prior.retryAt - now } as const;
        const attempts = prior.kind === "sending" ? prior.attempts + 1 : 1;
        head.progress = { kind: "sending", attempts, connectionId: session, retryAt: 0 };
        return { kind: "send", head, attempts, session } as const;
      });
      if (next.kind !== "send") return next;
      const { head, session } = next;
      if (connection.writable(scope) !== session) return { kind: "parked" } as const;
      this.lastAttempt.set(key, session);
      const reply = await connection.send({
        method: "input.send",
        commandId: head.commandId,
        payload: { threadId: scope.threadId, content: head.content },
      });
      if (reply) await this.reconcileReceipt(scope, reply);
      const after = 1000 * 2 ** Math.min(4, next.attempts - 1);
      const retry = await this.change(scope, (s) => {
        const item = s.queue.items.find((i) => i.commandId === head.commandId);
        if (item?.progress.kind !== "sending") return false;
        item.progress.retryAt = this.host.now() + after;
        return true;
      });
      if (retry) return { kind: "retry", after } as const;
      if (connection.writable(scope) === session)
        await this.reflectInstalled(scope, connection.installed);
      return { kind: "settled" } as const;
    });
  }
}
