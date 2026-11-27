import * as v from "valibot";
import {
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  NativeItemIdSchema,
  NativeRequestIdSchema,
  type TodoReplyContent,
  type NativeRequestId,
} from "@kraka/protocol";
import type {
  AdapterCommand,
  AdapterEventPayload,
  ApprovalAuthority,
  RequestBody,
} from "@kraka/environment";

export type RpcId = number | string;
const base = {
  threadId: NativeSessionIdSchema,
  turnId: NativeRootTurnIdSchema,
  itemId: NativeItemIdSchema,
};
const decisions = ["accept", "acceptForSession", "decline", "cancel"] as const;
const approvalSchema = v.object({
  ...base,
  availableDecisions: v.optional(v.nullable(v.array(v.unknown()))),
  approvalId: v.optional(v.nullable(v.string())),
});
const questionSchema = v.object({
  ...base,
  isBlocking: v.optional(v.boolean(), true),
  questions: v.array(
    v.object({
      id: v.pipe(v.string(), v.nonEmpty()),
      question: v.pipe(v.string(), v.nonEmpty()),
      isSecret: v.boolean(),
      options: v.optional(v.nullable(v.array(v.object({ label: v.string() })))),
    }),
  ),
});
export const callbackMethods = [
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/tool/requestUserInput",
] as const;
export const requestKey = (id: RpcId) =>
  v.parse(NativeRequestIdSchema, typeof id === "number" ? String(id) : "s:" + id);
export type Opened = Pick<
  Extract<AdapterEventPayload, { kind: "requestOpened" }>,
  "body" | "approval" | "recovery"
>;
export function serverRequest(method: string, raw: unknown, id: RpcId) {
  if (!callbackMethods.some((m) => m === method)) return null;
  const requestId = requestKey(id);
  if (method === callbackMethods[2]) {
    const p = v.parse(questionSchema, raw);
    const [first, ...rest] = p.questions;
    if (!first || new Set(p.questions.map((q) => q.id)).size !== p.questions.length)
      throw Error("Invalid question identifiers");
    const secret = p.questions.find((q) => q.isSecret);
    const question = (q: typeof first) => ({
      key: q.id,
      text: q.question,
      choices: q.options?.map((o) => o.label) ?? [],
    });
    const body: RequestBody = secret
      ? { kind: "secret", slot: secret.id, purpose: { kind: "toolOnce", tool: "requestUserInput" } }
      : { kind: "question", questions: [question(first), ...rest.map(question)] };
    const opened: Opened = {
      body,
      recovery: !secret && !p.isBlocking ? "messageFallback" : "liveOnly",
    };
    return { method: "callback" as const, ...p, id, requestId, opened };
  }
  const p = v.parse(approvalSchema, raw);
  const command = method === callbackMethods[0];
  const choices = decisions
    .filter((key) => p.availableDecisions == null || p.availableDecisions.includes(key))
    .map((choiceKey) => ({
      kind: "approval" as const,
      choiceKey,
      decision:
        choiceKey === "accept" || choiceKey === "acceptForSession"
          ? ("allow" as const)
          : ("deny" as const),
      scope: choiceKey === "acceptForSession" ? ("session" as const) : ("once" as const),
    }));
  const approval: ApprovalAuthority = {
    permission: command ? "term.input" : "workspace.change",
    choices,
  };
  const opened: Opened = {
    body: {
      kind: "approval",
      tool: command ? "command" : "file",
      choices: choices.map((c) => ({ key: c.choiceKey, scope: c.scope, allowsEdit: false })),
    },
    approval,
    recovery: "liveOnly",
  };
  return { method: "callback" as const, ...p, id, requestId, opened };
}
export type Callback = NonNullable<ReturnType<typeof serverRequest>>;
export type AnswerDelivery = Extract<AdapterCommand, { kind: "deliverAnswer" }>;
function nativeAnswer(request: Callback, reply: TodoReplyContent | undefined) {
  if (
    reply?.kind === "approval" &&
    request.opened.approval?.choices.some((c) => Bun.deepEquals(c, reply))
  )
    return { decision: reply.choiceKey };
  const body = request.opened.body;
  if (
    body.kind !== "question" ||
    reply?.kind !== "question" ||
    reply.answers.length !== body.questions.length
  )
    return null;
  const answers = new Map(reply.answers.map((a) => [a.questionKey, a.answer]));
  if (
    !body.questions.every((q) => {
      const a = answers.get(q.key);
      return a !== undefined && (!q.choices.length || q.choices.includes(a));
    })
  )
    return null;
  return { answers: Object.fromEntries([...answers].map(([k, a]) => [k, { answers: [a] }])) };
}
export class Callbacks {
  private readonly live = new Map<NativeRequestId, Callback>();
  private readonly seen = new Set<NativeRequestId>();
  open(request: Callback) {
    if (this.seen.has(request.requestId)) return false;
    this.seen.add(request.requestId);
    this.live.set(request.requestId, request);
    return true;
  }
  has(key: NativeRequestId) {
    return this.live.has(key);
  }
  close(key: NativeRequestId) {
    return this.live.delete(key);
  }
  clear() {
    this.live.clear();
  }
  async replyToNative(
    delivery: AnswerDelivery,
    write: (id: RpcId, result: object) => Promise<void>,
  ) {
    const request = this.live.get(delivery.requestId);
    if (
      !request ||
      delivery.answer.attemptId !== delivery.attemptId ||
      delivery.answer.deliveryId !== delivery.deliveryId
    )
      return { kind: "rejected", reason: "requestExpired", message: null } as const;
    const result = nativeAnswer(request, delivery.reply);
    if (!result || delivery.answer.content.kind !== "message")
      return { kind: "rejected", reason: "unsupported", message: null } as const;
    this.close(delivery.requestId);
    await write(request.id, result);
    return { kind: "ok", value: { kind: "written", deliveryId: delivery.deliveryId } } as const;
  }
}
