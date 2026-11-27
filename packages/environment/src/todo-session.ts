import * as v from "valibot";
import {
  TodoRequestSchema,
  type AdapterFamily,
  type Round,
  type NativeRequestId,
  type AttemptId,
} from "@kraka/protocol";
import {
  matchesAdapterEvent,
  type AdapterEventEnvelope,
  type AdapterSession,
  type ProviderAdapter,
  type CapabilityDeclaration,
} from "./adapter-contract";
import type { TodoLedger } from "./todo-ledger";

// Each callback and all of its evidence belong to this exact opened adapter handle.
export function bindTodoSession<F extends AdapterFamily, H extends object>(
  ledger: TodoLedger,
  round: Round,
  session: AdapterSession<F, H>,
  adapter: ProviderAdapter<F, H>,
  capabilities: CapabilityDeclaration<F>,
) {
  const requests = new Map<NativeRequestId, ReturnType<TodoLedger["open"]>>();
  const attempts = new Map<AttemptId, NativeRequestId>();
  return {
    event(e: AdapterEventEnvelope): boolean {
      const p = e.payload;
      if (!matchesAdapterEvent(session, e)) return false;
      if (p.kind === "requestOpened") {
        if (p.attemptId !== round.attempt.attemptId) return false;
        if (requests.has(p.requestId)) return true;
        const support = capabilities.matrix.answerApprovalChoices;
        if (support.kind === "unsupported" || !session.nativeSessionId)
          throw Error("Missing native reply capability");
        const todo = v.parse(TodoRequestSchema, {
          id: crypto.randomUUID(),
          threadId: round.threadId,
          roundId: round.id,
          version: "1",
          body: p.body,
          state: {
            kind: "open",
            route: {
              kind: "live",
              subject: p.body.kind,
              sessionId: session.nativeSessionId,
              requestId: p.requestId,
              fallback:
                p.recovery === "messageFallback" && p.body.kind === "question" && p.fallback
                  ? p.fallback
                  : { kind: "expire" },
            },
          },
        });
        requests.set(
          p.requestId,
          ledger.open(todo, {
            instanceId: session.instanceId,
            attemptId: p.attemptId,
            ...(p.approval ? { approval: p.approval } : {}),
            async send(answer, reply) {
              attempts.set(answer.attemptId, p.requestId);
              const result = await adapter.invoke(
                session,
                {
                  family: session.family,
                  instanceId: session.instanceId,
                  capability: "answerApprovalChoices",
                  support,
                  capabilityVersion: capabilities.version,
                },
                {
                  kind: "deliverAnswer",
                  capability: "answerApprovalChoices",
                  deliveryId: answer.deliveryId,
                  attemptId: answer.attemptId,
                  requestId: p.requestId,
                  answer,
                  ...(reply ? { reply } : {}),
                },
              );
              if (result.kind !== "ok" || result.value.kind !== "written")
                throw Error("Answer write unconfirmed");
              return result.value.deliveryId;
            },
          }),
        );
        return true;
      }
      if (p.kind !== "deliveryReceived" && p.kind !== "deliveryWritten") return false;
      if (p.kind === "deliveryReceived" && p.receipt.kind !== "answer") return false;
      const target = attempts.get(p.attemptId);
      if (!target) return p.kind === "deliveryReceived";
      const request = requests.get(target);
      const ticket = { attemptId: p.attemptId, deliveryId: p.deliveryId };
      if (p.kind === "deliveryWritten") request?.evidence({ ...ticket, kind: "written", at: p.at });
      else if (p.receipt.kind === "answer" && p.receipt.requestId === target)
        request?.evidence({
          ...ticket,
          kind: "received",
          proof: { sessionId: p.receipt.sessionId, requestId: target },
        });
      return true;
    },
    close() {
      for (const request of requests.values()) request.close();
      requests.clear();
      attempts.clear();
    },
  };
}
