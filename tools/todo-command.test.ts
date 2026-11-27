import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  HostInstanceIdSchema,
  PrincipalIdSchema,
  DeviceIdSchema,
  CommandIdSchema,
  AttemptIdSchema,
  DeliveryIdSchema,
  REQUEST_METHODS,
  SignedRequestSchema,
  TodoRequestSchema,
  CaptureIdSchema,
  NativeRequestIdSchema,
  TextReturnedEventSchema,
  type PermissionItem,
  type TodoAnswer,
} from "@kraka/protocol";
import {
  openWriter,
  openStore,
  acceptTodoReply,
  readReceipt,
  readRound,
  readMessage,
  recordInputEvidence,
} from "@kraka/environment";
import { withState } from "./fixtures/replay-process";
import {
  scenario,
  thread,
  round,
  source,
  native,
  message,
  todoFor,
  choices,
  seedRound,
} from "./fixtures/todo";

test("Only one reply commits, retries keep the first receipt, and the round and next input settle independently", async () => {
  await withState(async (dir) => {
    const lock = await openWriter(
      dir,
      v.parse(HostInstanceIdSchema, crypto.randomUUID()),
      performance.now() + 3000,
    );
    if (lock.kind !== "writer") throw Error("Missing writer");
    let store = openStore(lock.lease);
    try {
      seedRound(store);
      const request = scenario.inputs
        .flatMap((i) => (i.event.kind === "commands" ? i.event.requests : []))
        .find((r) => r.method === "todo.answer");
      if (request?.method !== "todo.answer" || request.signer.kind !== "device")
        throw Error("Missing fixture command");
      const actor = {
        id: v.parse(PrincipalIdSchema, "owner"),
        deviceId: request.signer.deviceId,
        environmentId: store.writer.environmentId,
        allows: (p: PermissionItem) => rights.has(p),
      };
      const rights = new Set<PermissionItem>(["thread.reply", "thread.view"]);
      const command = { ...request, environmentId: actor.environmentId };
      const todo = todoFor("question");
      const writes: TodoAnswer[] = [];
      const live = store.todos.open(todo, {
        ...native,
        attemptId: round.attempt.attemptId,
        async send(a) {
          writes.push(a);
          return a.deliveryId;
        },
      });
      const submit = (cmd = command, verifiedActor = actor) =>
        acceptTodoReply({ writer: store, verifiedActor, signedCommand: cmd });
      const id = () => v.parse(CommandIdSchema, crypto.randomUUID());
      const alt: typeof command = {
        ...command,
        commandId: id(),
        payload: { ...command.payload, answers: [{ questionKey: "title", answer: "Harbor" }] },
      };
      expect(
        submit({
          ...command,
          payload: { ...command.payload, answers: [{ questionKey: "wrong", answer: "Orchard" }] },
        }),
      ).toMatchObject({ failure: { kind: "invalidState" } });
      expect(
        submit({
          ...command,
          payload: { ...command.payload, answers: [{ questionKey: "title", answer: "Mint" }] },
        }),
      ).toMatchObject({ failure: { kind: "invalidState" } });
      store.beforeCommit = () => {
        throw Error("rollback");
      };
      expect(() => submit()).toThrow("rollback");
      expect(store.todos.get(todo.id)?.todo.state.kind).toBe("open");
      expect(writes).toHaveLength(0);
      delete store.beforeCommit;
      const approval = todoFor("approval");
      const attempts: TodoAnswer[] = [];
      const callback = store.todos.open(approval, {
        ...native,
        attemptId: round.attempt.attemptId,
        approval: { permission: "term.input", choices },
        async send(a) {
          attempts.push(a);
          throw Error("No proof of delivery");
        },
      });
      const approve = (decision: unknown) =>
        acceptTodoReply({
          writer: store,
          verifiedActor: actor,
          signedCommand: v.parse(REQUEST_METHODS.decideTodo.schema, {
            ...command,
            commandId: id(),
            method: "todo.decide",
            payload: { threadId: thread.id, todoRequestId: approval.id, decision },
          }),
        });
      rights.add("owner.decide");
      expect(approve(choices[0])).toMatchObject({
        failure: { kind: "missingPermission", permission: "term.input" },
      });
      rights.add("term.input");
      expect(approve({ ...choices[0], decision: "deny" })).toMatchObject({
        failure: { kind: "invalidState" },
      });
      expect(approve({ ...choices[0], scope: "persistent" })).toMatchObject({
        failure: { kind: "invalidState" },
      });
      expect(approve(choices[0]).kind).toBe("accepted");
      await Promise.resolve();
      const original = attempts[0];
      if (!original || approval.state.kind !== "open" || approval.state.route.kind !== "live")
        throw Error("Missing approval delivery");
      expect(store.todos.get(approval.id)?.todo.state).toMatchObject({
        arrival: { kind: "uncertain" },
      });
      const redo = {
        kind: "redeliver" as const,
        attemptId: original.attemptId,
        deliveryId: original.deliveryId,
        oldPathClosed: true as const,
        request: approval.state.route,
        newAttemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
        newDeliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
      };
      expect(callback.evidence({ ...redo, request: source })).toBe(false);
      expect(callback.evidence(redo)).toBe(true);
      await Promise.resolve();
      expect(callback.evidence(redo)).toBe(true);
      expect(attempts).toHaveLength(2);
      expect(store.todos.get(approval.id)?.todo.state).toMatchObject({
        previousAttempts: [
          {
            attemptId: original.attemptId,
            deliveryId: original.deliveryId,
            arrival: { kind: "uncertain" },
          },
        ],
        answer: { attemptId: redo.newAttemptId, deliveryId: redo.newDeliveryId },
      });
      callback.close();
      const win = submit();
      expect(win).toMatchObject({ kind: "accepted", result: { kind: "todoAnswerStored" } });
      const receipt = readReceipt(store.db, actor.id, command.commandId);
      expect(submit()).toEqual(win);
      expect(readReceipt(store.db, actor.id, command.commandId)).toEqual(receipt);
      expect(submit({ ...command, payload: alt.payload })).toMatchObject({
        failure: { kind: "idConflict" },
      });
      const loser = {
        ...actor,
        id: v.parse(PrincipalIdSchema, "other"),
        deviceId: v.parse(DeviceIdSchema, "other-device"),
      };
      const other = { ...alt, signer: { ...request.signer, deviceId: loser.deviceId } };
      rights.delete("thread.reply");
      expect(submit(other, loser)).toMatchObject({ failure: { kind: "missingPermission" } });
      expect(JSON.stringify(submit(other, loser))).not.toContain("current");
      expect(submit()).toEqual(win);
      rights.add("thread.reply");
      const lost = submit(other, loser);
      expect(lost).toMatchObject({ failure: { kind: "todoChanged", current: { id: todo.id } } });
      rights.delete("thread.view");
      expect(submit(other, loser)).toMatchObject({ failure: { kind: "missingPermission" } });
      rights.add("thread.view");
      const foreign = v.parse(SignedRequestSchema, {
        ...command,
        method: "todo.readAnswer",
        payload: { threadId: "elsewhere", todoRequestId: todo.id },
      });
      if (foreign.method !== "todo.readAnswer") throw Error("Invalid read");
      expect(
        acceptTodoReply({ writer: store, signedCommand: foreign, verifiedActor: actor }),
      ).toMatchObject({ failure: { kind: "notFound" } });
      const answer = writes[0]!;
      await Promise.resolve();
      expect(writes).toHaveLength(1);
      live.close();
      const unconfirmed = store.todos.get(todo.id)?.todo;
      expect(unconfirmed?.state).toMatchObject({
        kind: "answered",
        arrival: { kind: "uncertain" },
      });
      const ticket = { attemptId: answer.attemptId, deliveryId: answer.deliveryId };
      expect(
        live.evidence({
          ...ticket,
          kind: "received",
          proof: {
            sessionId: source.sessionId,
            requestId: v.parse(NativeRequestIdSchema, "unrelated"),
          },
        }),
      ).toBe(false);
      expect(
        live.evidence({
          ...ticket,
          kind: "received",
          deliveryId: round.attempt.deliveryId,
          proof: source,
        }),
      ).toBe(false);

      const ended = {
        kind: "rootEnded" as const,
        attemptId: round.attempt.attemptId,
        deliveryId: round.attempt.deliveryId,
        root: round.attempt.phase.kind === "working" ? round.attempt.phase.root : null,
        endedAt: 1200,
        endTimeEvidence: {
          source: "executorReported" as const,
          executorEndedAt: 1200,
          environmentObservedAt: null,
        },
        nativeReason: "done",
        outcome: "completed" as const,
        captureId: v.parse(CaptureIdSchema, "capture"),
      };
      if (!ended.root) throw Error("Missing fixture root");

      const fallback = v.parse(TodoRequestSchema, {
        ...todo,
        id: "fallback",
        state: {
          kind: "open",
          route: {
            ...source,
            requestId: "fallback-native",
            fallback: { kind: "asMessage", nodeId: "node", questions: [message.id] },
          },
        },
      });
      const path = store.todos.open(fallback, {
        ...native,
        attemptId: round.attempt.attemptId,
        async send() {
          throw Error("Closed path");
        },
      });
      path.close();
      expect(recordInputEvidence(store, native, { ...ended, root: ended.root }).kind).toBe("ok");
      expect(
        submit({
          ...command,
          commandId: id(),
          payload: { ...command.payload, todoRequestId: fallback.id },
        }).kind,
      ).toBe("accepted");
      const state = store.todos.get(fallback.id)?.todo.state;
      if (state?.kind !== "answered" || state.answer.content.kind !== "message")
        throw Error("Missing fallback");
      expect(state.arrival.kind).toBe("viaMessage");
      const next = readMessage(store.db, state.answer.content.messageId);
      if (!next?.roundId) throw Error("Missing linked input round");
      const returned = v.parse(TextReturnedEventSchema, {
        kind: "handoff.textReturned",
        version: "1",
        result: {
          kind: "textReturned",
          transferId: "handoff",
          source: { environmentId: actor.environmentId, threadId: thread.id, roundId: round.id },
          target: { environmentId: actor.environmentId, threadId: thread.id },
          text: next.text,
          history: { coverage: "complete", missingSources: [], omittedItems: 0 },
          input: {
            messageId: next.id,
            roundId: next.roundId,
            attemptId: state.answer.attemptId,
            deliveryId: state.answer.deliveryId,
          },
        },
      });
      store.db.transaction(() => store.sync.record([], { returns: [returned] }))();
      store.db.close();
      store = openStore(lock.lease);
      expect(store.todos.get(todo.id)?.todo).toEqual(unconfirmed);
      expect(readRound(store.db, round.id)?.attempt.phase).toMatchObject({
        kind: "closing",
        endedAt: 1200,
        endTimeEvidence: ended.endTimeEvidence,
      });
      expect(readRound(store.db, next.roundId)?.attempt).toMatchObject({
        attemptId: returned.result.input.attemptId,
        deliveryId: returned.result.input.deliveryId,
      });
      expect(returned.result.input.deliveryId).not.toBe(answer.deliveryId);
      expect(
        store.sync.read(
          {
            threadId: thread.id,
            environmentId: actor.environmentId,
            canRead: () => true,
            timelineItems: true,
            protocolMinor: 1,
          },
          "owner",
        ).returns[0]?.event,
      ).toEqual(returned);
    } finally {
      store.db.close();
      lock.close();
    }
  });
});
