import * as v from "valibot";
import { join } from "node:path";
import {
  TodoRequestSchema,
  MessageSchema,
  RoundSchema,
  ThreadSchema,
  ExecutorInstanceIdSchema,
  TodoDecisionSchema,
} from "@kraka/protocol";
import type { FirstSendStore } from "@kraka/environment";
import { parseScenario } from "./scenario";
export const scenario = parseScenario(
  await Bun.file(join(import.meta.dir, "../../fixtures/scenarios/first-answer-wins.json")).json(),
);
const rows = scenario.environments[0]!.objects;
export const thread = v.parse(ThreadSchema, rows.find((r) => r.objectType === "thread")?.value);
export const message = v.parse(MessageSchema, rows.find((r) => r.objectType === "message")?.value);
export const round = v.parse(RoundSchema, rows.find((r) => r.objectType === "round")?.value);
const question = v.parse(
  TodoRequestSchema,
  rows.find((r) => r.objectType === "todoRequest")?.value,
);
export const source = (() => {
  if (question.state.kind !== "open" || question.state.route.kind !== "live")
    throw Error("Missing live request");
  return question.state.route;
})();
export const choices = ["accept", "decline"].map((choiceKey, i) =>
  v.parse(TodoDecisionSchema.options[0], {
    kind: "approval",
    choiceKey,
    decision: i ? "deny" : "allow",
    scope: "once",
  }),
);
export const native = {
  family: "replay" as const,
  instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
  nativeSessionId: source.sessionId,
  epoch: 1,
};
export function todoFor(kind: string) {
  if (kind === "question") return question;
  const body =
    kind === "secret"
      ? { kind, slot: "credential", purpose: { kind: "toolOnce", tool: "lookup" } }
      : {
          kind: "approval",
          tool: "command",
          choices: choices.map((c) => ({ key: c.choiceKey, scope: c.scope, allowsEdit: false })),
        };
  return v.parse(TodoRequestSchema, {
    ...question,
    id: "todo-" + kind,
    body,
    state: { kind: "open", route: { ...source, subject: body.kind, requestId: "native-" + kind } },
  });
}
export function seedRound(store: FirstSendStore) {
  store.db.transaction(() => {
    store.db.run("INSERT INTO threads VALUES(?,?)", [thread.id, JSON.stringify(thread)]);
    store.db.run("INSERT INTO rounds VALUES(?,?,'person')", [round.id, JSON.stringify(round)]);
    store.db.run("INSERT INTO messages VALUES(?,?)", [message.id, JSON.stringify(message)]);
    store.db.run("INSERT INTO deliveries VALUES(?,?,1,NULL)", [round.attempt.deliveryId, round.id]);
    store.freeze({
      ...round.attempt,
      target: native,
      messageVersion: message.version,
      input: { id: message.id, text: message.text, references: [], attachments: [] },
      parts: [],
    });
    store.sync.record([
      { objectType: "thread", value: thread },
      { objectType: "round", value: round },
      { objectType: "message", value: message },
    ]);
  })();
}
