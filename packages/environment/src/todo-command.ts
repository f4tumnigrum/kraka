import * as v from "valibot";
import {
  canonicalJson,
  REQUEST_METHODS,
  PRIVATE_SECRET_METHOD,
  TodoReplyRecordSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  MessageSchema,
  MessageIdSchema,
  RoundIdSchema,
  SecretReceiptSchema,
  type SignedRequest,
  type PrivateSecretRequest,
  type DeviceId,
  type CommandReceipt,
  type PermissionItem,
  type TodoRequest,
  type TodoReplyContent,
  type TodoReplyRecord,
  type SecretReceipt,
  type CommandId,
  type TodoAnswer,
  type Message,
  type Round,
  type AuthorizationTarget,
} from "@kraka/protocol";
import { type FirstSendStore, readReceipt, readThread } from "./first-send-store";
import { commandIntent, checkCommand, type LocalActor } from "./command-receipts";
import { advanceQueue, fileInputRound, loadQueue } from "./input-store";
import { transitionTodo } from "./todo";
type TodoCommand =
  | Extract<
      SignedRequest,
      { method: "todo.answer" | "todo.decide" | "todo.readAnswer" | "todo.readSecretReceipt" }
    >
  | PrivateSecretRequest;
type Context = {
  verifiedActor: LocalActor &
    ({ deviceId: DeviceId } | { executor: NonNullable<LocalActor["executor"]> });
  signedCommand: TodoCommand;
  writer: FirstSendStore;
};
const reject = (
  commandId: CommandId,
  failure: Extract<CommandReceipt, { kind: "rejected" }>["failure"],
): CommandReceipt => ({ kind: "rejected", commandId, failure });
function secretReceipt(writer: FirstSendStore, id: CommandId) {
  const row = writer.db
    .query<{ metadata: string }, [string]>(
      "SELECT metadata FROM private_todo_receipts WHERE command=?",
    )
    .get(id);
  return row && v.parse(SecretReceiptSchema, JSON.parse(row.metadata));
}
function validAnswers(todo: TodoRequest, content: TodoReplyContent) {
  if (content.kind === "approval")
    return (
      todo.body.kind === "approval" &&
      todo.body.choices.some(
        (c) =>
          c.key === content.choiceKey &&
          c.scope === content.scope &&
          (content.decision !== "allowEdited" || c.allowsEdit),
      )
    );
  if (todo.body.kind !== "question") return false;
  const answers = new Map(content.answers.map((a) => [a.questionKey, a.answer]));
  return (
    answers.size === content.answers.length &&
    answers.size === todo.body.questions.length &&
    new Set(todo.body.questions.map((q) => q.key)).size === answers.size &&
    todo.body.questions.every((q) => {
      const answer = answers.get(q.key);
      return answer !== undefined && (!q.choices.length || q.choices.includes(answer));
    })
  );
}
function storePublicReply(
  writer: FirstSendStore,
  todo: TodoRequest,
  record: TodoReplyRecord,
  answer: TodoAnswer,
) {
  const route = todo.state.kind === "open" && todo.state.route;
  if (!route) throw Error("Closed todo");
  const roundId =
    route.kind === "message" ? v.parse(RoundIdSchema, crypto.randomUUID()) : todo.roundId;
  const message = v.parse(MessageSchema, {
    threadId: todo.threadId,
    id: record.messageId,
    roundId,
    version: "1",
    author:
      record.kind === "todoAnswerRead"
        ? { kind: "person", id: record.authorId }
        : { kind: "executor", id: record.executor.executorInstanceId },
    text:
      record.content.kind === "approval"
        ? record.content.choiceKey
        : record.content.answers.map((a) => a.answer).join("\n"),
    attachments: [],
    references: [],
  });
  writer.db.run("INSERT INTO messages VALUES(?,?)", [message.id, JSON.stringify(message)]);
  writer.db.run("INSERT INTO todo_replies VALUES(?,?)", [message.id, JSON.stringify(record)]);
  const rows: (
    | { objectType: "message"; value: Message }
    | { objectType: "round"; value: Round }
  )[] = [{ objectType: "message", value: message }];
  if (route.kind === "message") {
    rows.push({
      objectType: "round",
      value: fileInputRound(writer, loadQueue(writer, todo.threadId), roundId, message.id, answer),
    });
    advanceQueue(writer, todo.threadId);
  }
  return rows;
}
export function acceptTodoReply({
  verifiedActor: actor,
  signedCommand: cmd,
  writer,
}: Context): CommandReceipt {
  const privateRequest = cmd.method === "todo.submitSecret";
  const ids = privateRequest ? cmd.payload.target : cmd.payload;
  const { commandId } = cmd;
  const target: AuthorizationTarget = { kind: "thread", threadId: ids.threadId };
  const fail = (kind: "notFound" | "invalidState" | "idConflict" | "unsupported") =>
    reject(commandId, { kind });
  const denied = (permission: PermissionItem) =>
    reject(commandId, { kind: "missingPermission", permission, target });
  const accepted = (
    result: Extract<CommandReceipt, { kind: "accepted" }>["result"],
  ): CommandReceipt => ({ kind: "accepted", commandId, result });
  let deliver = false;
  const result = writer.db
    .transaction((): CommandReceipt => {
      if (
        actor.environmentId !== writer.writer.environmentId ||
        actor.environmentId !== cmd.environmentId ||
        (cmd.signer.kind === "device"
          ? !("deviceId" in actor) || cmd.signer.deviceId !== actor.deviceId || !!actor.executor
          : !actor.executor ||
            cmd.signer.principalId !== actor.id ||
            !writer.services.executorTools.authorizes(cmd.signer, actor.executor) ||
            actor.executor.threadId !== ids.threadId ||
            (cmd.method !== "todo.answer" && cmd.method !== "todo.readAnswer"))
      )
        return reject(commandId, { kind: "invalidProof" });
      if (
        actor.executor &&
        !actor.allows(cmd.method === "todo.readAnswer" ? "thread.view" : "thread.reply", target)
      )
        return denied(cmd.method === "todo.readAnswer" ? "thread.view" : "thread.reply");
      const row = writer.todos.get(ids.todoRequestId);
      if (!row || row.todo.threadId !== ids.threadId || !readThread(writer.db, ids.threadId))
        return fail("notFound");
      const { todo, binding } = row;
      if (
        actor.executor &&
        (todo.body.kind !== "question" ||
          binding.attemptId !== actor.executor.attemptId ||
          binding.instanceId !== actor.executor.executorInstanceId)
      )
        return fail("notFound");
      const permission =
        cmd.method === "todo.readAnswer"
          ? "thread.view"
          : cmd.method === "todo.answer"
            ? "thread.reply"
            : "owner.decide";
      const may = (p: PermissionItem) => actor.allows(p, target);
      if (cmd.method === "todo.readAnswer") {
        if (!may(permission)) return denied(permission);
        if (
          todo.body.kind === "secret" ||
          todo.state.kind !== "answered" ||
          todo.state.answer.content.kind !== "message"
        )
          return fail("notFound");
        const record = writer.todos.reply(todo.state.answer.content.messageId);
        if (!record) return fail("notFound");
        if (!actor.executor) return accepted(record);
        const intent = commandIntent(actor, cmd.method, target, cmd.payload);
        const old = readReceipt(writer.db, actor.id, commandId);
        if (old) return old.intent === intent ? old.receipt : fail("idConflict");
        const receipt = accepted(record);
        writer.db.run("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)", [
          actor.id,
          commandId,
          intent,
          JSON.stringify(receipt),
        ]);
        return receipt;
      }
      if (cmd.method === "todo.readSecretReceipt") {
        if (!may(permission)) return denied(permission);
        const receipt = secretReceipt(writer, cmd.payload.receiptCommandId);
        return receipt &&
          receipt.target.todoRequestId === todo.id &&
          receipt.target.threadId === todo.threadId
          ? accepted({ kind: "secretReceipt", receipt })
          : fail("notFound");
      }
      const payload = privateRequest ? cmd.payload.target : cmd.payload;
      const prior = readReceipt(writer.db, actor.id, commandId);
      if (prior) {
        if (!may("thread.view")) return denied("thread.view");
        if (prior.receipt.kind === "rejected" || privateRequest) {
          if (!may(permission)) return denied(permission);
          if (binding.approval && !may(binding.approval.permission))
            return denied(binding.approval.permission);
        }
        if (prior.intent !== commandIntent(actor, cmd.method, target, payload))
          return fail("idConflict");
        if (privateRequest && prior.receipt.kind === "accepted") {
          const saved = writer.db
            .query<{ choice: string }, [string]>(
              "SELECT choice FROM private_todo_receipts WHERE command=?",
            )
            .get(commandId);
          if (saved?.choice !== canonicalJson(cmd.payload.choice)) return fail("idConflict");
        }
        return prior.receipt;
      }
      const operation = privateRequest
        ? PRIVATE_SECRET_METHOD
        : cmd.method === "todo.answer"
          ? REQUEST_METHODS.answerTodo
          : REQUEST_METHODS.decideTodo;
      const checked = checkCommand(
        { actor, commandId, transaction: writer },
        operation,
        payload,
        target,
      );
      if (checked.receipt) return checked.receipt;
      if (
        (cmd.method === "todo.answer") !== (todo.body.kind === "question") ||
        (cmd.method === "todo.decide" && cmd.payload.decision.kind !== todo.body.kind) ||
        (privateRequest && todo.body.kind !== "secret")
      )
        return fail("invalidState");
      if (todo.body.kind === "approval") {
        if (cmd.method !== "todo.decide" || !binding.approval) return fail("unsupported");
        if (!may(binding.approval.permission)) return denied(binding.approval.permission);
      }
      // A conflict can carry the current request only to a current reader.
      if (todo.state.kind !== "open" && !may("thread.view")) return denied("thread.view");
      const save = (receipt: CommandReceipt) => {
        writer.db.run("INSERT INTO receipts(actor,command,intent,data) VALUES(?,?,?,?)", [
          actor.id,
          commandId,
          checked.intent,
          JSON.stringify(receipt),
        ]);
        writer.beforeCommit?.(cmd.method);
        return receipt;
      };
      if (privateRequest) {
        const actual = writer.todos.secretTarget(todo);
        if (
          todo.state.kind !== "open" ||
          !actual ||
          canonicalJson(actual) !== canonicalJson(cmd.payload.target)
        )
          return fail("invalidState");
        if (secretReceipt(writer, commandId)) return fail("idConflict");
        const savedAt = Date.now();
        const receipt: SecretReceipt = {
          receiptCommandId: commandId,
          ownerId: actor.id,
          target: actual,
          savedAt,
          expiresAt: savedAt + 86400000,
          decision: cmd.payload.choice.kind === "declined" ? "declined" : "stored",
        };
        writer.db.run("INSERT INTO private_todo_receipts VALUES(?,?,?)", [
          commandId,
          JSON.stringify(receipt),
          canonicalJson(cmd.payload.choice),
        ]);
        return save(accepted({ kind: "secretReceipt", receipt }));
      }
      if (todo.state.kind !== "open")
        return save(reject(commandId, { kind: "todoChanged", current: todo }));
      const route = todo.state.route;
      if (route.kind === "message" && binding.nativeNode) {
        const thread = readThread(writer.db, todo.threadId);
        if (!thread || !writer.directory(thread)) return fail("invalidState");
      }
      if (route.kind === "live" && !writer.todos.isLive(todo)) return fail("invalidState");
      const content =
        cmd.method === "todo.answer"
          ? { kind: "question" as const, answers: cmd.payload.answers }
          : cmd.payload.decision;
      if (content.kind === "secret") {
        const receipt = secretReceipt(writer, content.receiptCommandId);
        const live = writer.todos.secretTarget(todo);
        if (
          !live ||
          !receipt ||
          receipt.ownerId !== actor.id ||
          Date.now() >= receipt.expiresAt ||
          canonicalJson(receipt.target) !== canonicalJson(live)
        )
          return fail("invalidState");
      } else if (
        !validAnswers(todo, content) ||
        (content.kind === "approval" &&
          !binding.approval?.choices.some((c) => canonicalJson(c) === canonicalJson(content)))
      )
        return fail("invalidState");
      const at = Date.now();
      const link =
        content.kind === "secret"
          ? { kind: "secretReceipt" as const, commandId: content.receiptCommandId }
          : { kind: "message" as const, messageId: v.parse(MessageIdSchema, crypto.randomUUID()) };
      const record =
        link.kind === "message"
          ? v.parse(TodoReplyRecordSchema, {
              ...("deviceId" in actor
                ? { kind: "todoAnswerRead", deviceId: actor.deviceId, authorId: actor.id }
                : { kind: "executorAnswerRead", executor: actor.executor }),
              todoRequestId: todo.id,
              messageId: link.messageId,
              at,
              content,
            })
          : null;
      const answer: TodoAnswer = {
        authorId: actor.id,
        ...("deviceId" in actor && { deviceId: actor.deviceId }),
        at,
        attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
        deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
        content: link,
      };
      const next = transitionTodo(todo.state, {
        kind: "answer",
        answer,
        target: route.kind === "live" ? route : null,
      });
      if (next.kind === "rejected") return fail("invalidState");
      writer.todos.save(
        todo,
        next.value,
        record ? storePublicReply(writer, todo, record, answer) : [],
      );
      deliver = route.kind === "live";
      return save(accepted({ kind: "todoAnswerStored", todoRequestId: todo.id }));
    })
    .immediate();
  if (result.kind === "accepted" && result.result.kind === "todoAnswerStored") {
    writer.sync.notify();
    if (deliver) {
      const send = () => {
        void writer.todos.dispatch(ids.todoRequestId);
      };
      if (writer.db.inTransaction) queueMicrotask(send);
      else send();
    }
  }
  return result;
}
