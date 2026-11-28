import { join } from "node:path";
import * as v from "valibot";
import {
  HostInstanceIdSchema,
  TodoRequestIdSchema,
  DeviceIdSchema,
  PrincipalIdSchema,
  REQUEST_METHODS,
  CommandIdSchema,
  type TodoReplyContent,
} from "@kraka/protocol";
import {
  acceptTodoReply,
  bindTodoSession,
  openStore,
  openWriter,
  type AdapterEventEnvelope,
  type AdapterSession,
  type ProviderAdapter,
} from "@kraka/environment";
import { scenario, round, thread, message } from "./todo";

// Exercise the writer's decision transaction with two already-verified device principals.
export async function claudeDecisionStore<H extends object>(
  directory: string,
  session: AdapterSession<"claude-code", H>,
  adapter: ProviderAdapter<"claude-code", H>,
  event: AdapterEventEnvelope<"claude-code">,
) {
  if (event.payload.kind !== "requestOpened") throw Error("Expected request");
  const attemptId = event.payload.attemptId;
  const declaration = await adapter.capabilities(session);
  if (declaration.kind !== "ok") throw Error("Missing capability declaration");
  const writer = await openWriter(
    join(directory, "state"),
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 5000,
  );
  if (writer.kind !== "writer") throw Error("Missing disposable writer");
  const store = openStore(writer.lease);
  try {
    const current = { ...round, attempt: { ...round.attempt, attemptId } };
    const { family, instanceId, nativeSessionId, epoch } = session;
    store.db.transaction(() => {
      store.db.run("INSERT INTO threads VALUES(?,?)", [thread.id, JSON.stringify(thread)]);
      store.db.run("INSERT INTO rounds VALUES(?,?,'person')", [
        current.id,
        JSON.stringify(current),
      ]);
      store.db.run("INSERT INTO messages VALUES(?,?)", [message.id, JSON.stringify(message)]);
      store.db.run("INSERT INTO deliveries VALUES(?,?,1,NULL)", [
        current.attempt.deliveryId,
        current.id,
      ]);
      store.freeze({
        attemptId,
        deliveryId: current.attempt.deliveryId,
        target: { family, instanceId, nativeSessionId, epoch },
        messageVersion: message.version,
        input: { id: message.id, text: message.text, references: [], attachments: [] },
        parts: [],
      });
    })();
    const live = bindTodoSession(store.todos, current, session, adapter, declaration.value);
    if (!live.event(event)) throw Error("Unbound request");
    const todoRequestId = v.parse(
      TodoRequestIdSchema,
      store.db.query<{ id: string }, []>("SELECT id FROM todo_requests").get()?.id,
    );
    const template = scenario.inputs.flatMap((i) =>
      i.event.kind === "commands" ? i.event.requests : [],
    )[0];
    if (!template || template.signer.kind !== "device") throw Error("Missing fixture device");
    const base = template,
      signer = template.signer;
    function command(device: string, decision?: TodoReplyContent) {
      const deviceId = v.parse(DeviceIdSchema, device);
      const verifiedActor = {
        deviceId,
        id: v.parse(PrincipalIdSchema, device),
        environmentId: store.writer.environmentId,
        allows: () => true,
      };
      const common = {
        ...base,
        environmentId: verifiedActor.environmentId,
        commandId: v.parse(CommandIdSchema, crypto.randomUUID()),
        signer: { ...signer, deviceId },
      };
      const payload = { threadId: thread.id, todoRequestId };
      const signedCommand = decision
        ? v.parse(REQUEST_METHODS.decideTodo.schema, {
            ...common,
            method: "todo.decide",
            payload: { ...payload, decision },
          })
        : v.parse(REQUEST_METHODS.readAnswer.schema, {
            ...common,
            method: "todo.readAnswer",
            payload,
          });
      return acceptTodoReply({ writer: store, verifiedActor, signedCommand });
    }
    return {
      command,
      close() {
        live.close();
        store.db.close(true);
        writer.close();
      },
    };
  } catch (error) {
    store.db.close(true);
    writer.close();
    throw error;
  }
}
