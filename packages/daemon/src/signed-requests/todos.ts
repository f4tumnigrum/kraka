import { acceptTodoReply } from "@kraka/environment";
import { sendLogicalRequest } from "@kraka/protocol";
import type { Handler } from "./context";
export const todo: Handler<
  "todo.answer" | "todo.decide" | "todo.readAnswer" | "todo.readSecretReceipt" | "todo.submitSecret"
> = (
  m,
  { host, store, principal, deviceId, peer, allows, disclosures, schedule, wake, beforeTodo },
) => {
  const proceed = () => {
    const result = host.store.db
      .transaction(() =>
        acceptTodoReply({
          verifiedActor: { ...principal, deviceId },
          signedCommand: m,
          writer: store,
        }),
      )
      .immediate();
    const stream = sendLogicalRequest(peer, result);
    const thread =
      m.method === "todo.submitSecret" ? m.payload.target.threadId : m.payload.threadId;
    if (
      result.kind === "accepted" &&
      (result.result.kind === "todoAnswerRead" || result.result.kind === "secretReceipt")
    ) {
      const right = result.result.kind === "secretReceipt" ? "owner.decide" : "thread.view";
      disclosures.set(m.commandId, { stream, allowed: () => allows(thread, right) });
    } else if (result.kind === "rejected" && result.failure.kind === "todoChanged") {
      const required = m.method === "todo.answer" ? "thread.reply" : "owner.decide";
      const action = store.todos.get(result.failure.current.id)?.binding.approval?.permission;
      disclosures.set(m.commandId, {
        stream,
        allowed: () =>
          allows(thread, "thread.view") &&
          allows(thread, required) &&
          (!action || allows(thread, action)),
      });
    }
    if (result.kind === "accepted" && result.result.kind === "todoAnswerStored") {
      const todo = store.todos.get(result.result.todoRequestId)?.todo;
      if (todo?.state.kind === "answered" && todo.state.route.kind === "message")
        schedule(todo.threadId, m.commandId);
    }
    wake();
  };
  if (beforeTodo && (m.method === "todo.answer" || m.method === "todo.decide"))
    beforeTodo(m.commandId, proceed);
  else proceed();
};
