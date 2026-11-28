import * as v from "valibot";
import {
  TodoRequestSchema,
  AdapterFamilySchema,
  NativeItemIdSchema,
  TodoDecisionSchema,
  PermissionItemSchema,
  ExecutorInstanceIdSchema,
  AttemptIdSchema,
  TodoReplyRecordSchema,
  type TodoRequest,
  type TodoRequestId,
  type TodoReplyContent,
  type TodoAnswer,
  type Message,
  type Round,
  type TodoState,
  type DeliveryId,
  type SecretTarget,
  type AdapterFamily,
} from "@kraka/protocol";
import { readRound, readMessage, readThread, type FirstSendStore } from "./first-send-store";
import { frozenInput, nextVersion } from "./input-store";
import { transitionTodo, type TodoEvent, type AnswerEvent } from "./todo";
import type { ApprovalAuthority } from "./adapter-contract";

export type LiveTodo = {
  instanceId: SecretTarget["instanceId"];
  family: AdapterFamily;
  epoch: number;
  attemptId: SecretTarget["attemptId"];
  approval?: ApprovalAuthority;
  available?: () => boolean;
  nativeNode?: import("@kraka/protocol").NativeItemId;
  send: (answer: TodoAnswer, content: TodoReplyContent | null) => Promise<DeliveryId>;
};
const binding = v.object({
  family: v.optional(AdapterFamilySchema),
  epoch: v.optional(v.number()),
  nativeNode: v.optional(NativeItemIdSchema),
  instanceId: ExecutorInstanceIdSchema,
  attemptId: AttemptIdSchema,
  approval: v.optional(
    v.object({ permission: PermissionItemSchema, choices: v.array(TodoDecisionSchema.options[0]) }),
  ),
});
type Row = { data: string; binding: string };
export const todoTables = `CREATE TABLE IF NOT EXISTS todo_requests(id TEXT PRIMARY KEY, data TEXT NOT NULL, binding TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS todo_question_nodes(request TEXT PRIMARY KEY,node TEXT NOT NULL,questions TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS todo_replies(message TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS private_todo_receipts(command TEXT PRIMARY KEY, metadata TEXT NOT NULL, choice TEXT NOT NULL);`;

export class TodoLedger {
  private live = new Map<TodoRequestId, LiveTodo>();
  constructor(private store: FirstSendStore) {}
  recover() {
    const db = this.store.db;
    db.transaction(() => {
      for (const row of db
        .query<{ data: string }, []>(
          "SELECT data FROM todo_requests WHERE json_extract(data,'$.state.route.kind')='live' AND (json_extract(data,'$.state.kind')='open' OR json_extract(data,'$.state.arrival.kind') IN ('recorded','armed','handed'))",
        )
        .all()) {
        this.lost(v.parse(TodoRequestSchema, JSON.parse(row.data)));
      }
    })();
  }
  get(id: TodoRequestId) {
    const row = this.store.db
      .query<Row, [string]>("SELECT data,binding FROM todo_requests WHERE id=?")
      .get(id);
    return (
      row && {
        todo: v.parse(TodoRequestSchema, JSON.parse(row.data)),
        binding: v.parse(binding, JSON.parse(row.binding)),
      }
    );
  }
  reply(message: Message["id"]) {
    const row = this.store.db
      .query<{ data: string }, [string]>("SELECT data FROM todo_replies WHERE message=?")
      .get(message);
    return row && v.parse(TodoReplyRecordSchema, JSON.parse(row.data));
  }
  private bound(todo: TodoRequest, native: LiveTodo) {
    if (todo.state.kind === "expired" || todo.state.route.kind !== "live") return false;
    const round = readRound(this.store.db, todo.roundId);
    if (
      !round ||
      round.threadId !== todo.threadId ||
      round.attempt.attemptId !== native.attemptId ||
      ["closing", "finished", "endedEarly", "notDelivered"].includes(round.attempt.phase.kind)
    )
      return false;
    const frozen = frozenInput(this.store, round.attempt.deliveryId);
    return (
      frozen?.target.instanceId === native.instanceId &&
      frozen.target.family === native.family &&
      frozen.target.epoch === native.epoch &&
      frozen.target.nativeSessionId === todo.state.route.sessionId
    );
  }
  isLive(todo: TodoRequest) {
    const native = this.live.get(todo.id);
    return !!native && (native.available?.() ?? true) && this.bound(todo, native);
  }
  open(todo: TodoRequest, native: LiveTodo, questions: Message[] = []) {
    const metadata = v.parse(binding, native);
    if (
      !this.bound(todo, native) ||
      !readThread(this.store.db, todo.threadId) ||
      todo.state.kind !== "open" ||
      todo.state.route.kind !== "live" ||
      todo.state.route.subject !== todo.body.kind
    )
      throw Error("Unbound todo request");
    const route = todo.state.route;
    this.store.db.transaction(() => {
      this.store.db.run("INSERT INTO todo_requests VALUES(?,?,?)", [
        todo.id,
        JSON.stringify(todo),
        JSON.stringify(metadata),
      ]);
      for (const question of questions)
        this.store.db.run("INSERT INTO messages VALUES(?,?)", [
          question.id,
          JSON.stringify(question),
        ]);
      if (questions.length && route.fallback.kind === "asMessage")
        this.store.db.run("INSERT INTO todo_question_nodes VALUES(?,?,?)", [
          todo.id,
          route.fallback.nodeId,
          JSON.stringify(questions.map((q) => q.id)),
        ]);
      this.store.sync.record([
        ...questions.map((value) => ({ objectType: "message" as const, value })),
        { objectType: "todoRequest", value: todo },
      ]);
    })();
    this.live.set(todo.id, native);
    this.store.sync.notify();
    return {
      evidence: (event: AnswerEvent) => this.observe(todo.id, { kind: "delivery", event }),
      close: (resolved = false) => {
        if (this.live.get(todo.id) !== native) return;
        this.live.delete(todo.id);
        const current = this.get(todo.id)?.todo;
        if (
          current &&
          current.state.kind !== "expired" &&
          current.state.route.kind === "live" &&
          current.state.route.sessionId === route.sessionId
        )
          this.store.db.transaction(() => this.lost(current, resolved))();
        this.store.sync.notify();
      },
    };
  }
  private lost(todo: TodoRequest, resolved = false) {
    if (todo.state.kind === "expired" || todo.state.route.kind !== "live") return;
    const route = todo.state.route;
    const fallback = route.fallback;
    const thread = readThread(this.store.db, todo.threadId);
    const node = this.store.db
      .query<{ node: string; questions: string }, [string]>(
        "SELECT node,questions FROM todo_question_nodes WHERE request=?",
      )
      .get(todo.id);
    const original = this.get(todo.id)?.binding.nativeNode;
    const eligible =
      !resolved &&
      thread &&
      (!original ||
        (this.store.directory(thread) &&
          node &&
          fallback.kind === "asMessage" &&
          node.node === original &&
          node.node === fallback.nodeId &&
          Bun.deepEquals(JSON.parse(node.questions), fallback.questions)));
    const questions =
      eligible && fallback.kind === "asMessage"
        ? fallback.questions.flatMap((id) => {
            const m = readMessage(this.store.db, id);
            return m?.threadId === todo.threadId && (!original || m.roundId === todo.roundId)
              ? [m]
              : [];
          })
        : [];
    this.apply(todo, {
      kind: "sessionLost",
      sessionId: route.sessionId,
      reason: resolved ? "native request resolved" : "native session closed: not resumable",
      messageFallback:
        fallback.kind === "asMessage" ? { nodeId: fallback.nodeId, questions } : null,
    });
  }
  save(
    todo: TodoRequest,
    state: TodoState,
    rows: (
      | { objectType: "message"; value: Message }
      | { objectType: "round"; value: Round }
    )[] = [],
  ) {
    const updated = { ...todo, state, version: nextVersion(todo.version) };
    const changed = this.store.db.run(
      "UPDATE todo_requests SET data=? WHERE id=? AND json_extract(data,'$.version')=? AND json_extract(data,'$.state.kind')=?",
      [JSON.stringify(updated), todo.id, todo.version, todo.state.kind],
    );
    if (changed.changes !== 1) throw Error("Todo changed during write");
    this.store.sync.record([{ objectType: "todoRequest", value: updated }, ...rows]);
  }
  private apply(todo: TodoRequest, event: TodoEvent) {
    const result = transitionTodo(todo.state, event);
    if (result.kind === "ok" && !Bun.deepEquals(result.value, todo.state))
      this.save(todo, result.value);
    return result.kind === "ok";
  }
  observe(id: TodoRequestId, event: Extract<TodoEvent, { kind: "delivery" }>) {
    const applied = this.store.db.transaction(() => {
      const todo = this.get(id)?.todo;
      return (
        !!todo && (event.event.kind !== "redeliver" || this.isLive(todo)) && this.apply(todo, event)
      );
    })();
    this.store.sync.notify();
    if (applied && event.event.kind === "redeliver") void this.dispatch(id);
    return applied;
  }
  async dispatch(id: TodoRequestId) {
    const native = this.live.get(id);
    const todo = this.get(id)?.todo;
    if (!native || todo?.state.kind !== "answered" || todo.state.arrival.kind !== "recorded")
      return;
    const { answer } = todo.state;
    const ticket = { attemptId: answer.attemptId, deliveryId: answer.deliveryId };
    const content =
      answer.content.kind === "message" ? this.reply(answer.content.messageId)?.content : null;
    if (content === undefined) throw Error("Missing recorded reply");
    const report = (event: AnswerEvent) => this.observe(id, { kind: "delivery", event });
    if (!report({ kind: "claim", ...ticket })) return;
    try {
      const written = await native.send(answer, content);
      if (written !== answer.deliveryId) throw Error("Unconfirmed write");
      report({ kind: "written", ...ticket, at: Date.now() });
    } catch {
      report({ kind: "unknown", ...ticket });
    }
  }
  secretTarget(todo: TodoRequest): SecretTarget | null {
    if (
      todo.body.kind !== "secret" ||
      !todo.body.purpose ||
      todo.state.kind === "expired" ||
      todo.state.route.kind !== "live" ||
      !this.isLive(todo)
    )
      return null;
    const thread = readThread(this.store.db, todo.threadId),
      meta = this.get(todo.id)?.binding;
    if (!thread || !meta) return null;
    return {
      environmentId: this.store.writer.environmentId,
      projectId: thread.projectId,
      threadId: thread.id,
      todoRequestId: todo.id,
      version: todo.version,
      attemptId: meta.attemptId,
      instanceId: meta.instanceId,
      sessionId: todo.state.route.sessionId,
      requestId: todo.state.route.requestId,
      purpose: todo.body.purpose,
    };
  }
}
