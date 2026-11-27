import { turnAction } from "./input-peer-control";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { createReplayAdapter } from "@kraka/adapter-replay";
import type { AdapterEventEnvelope } from "@kraka/environment";
import {
  type AttemptId,
  type DeliveryId,
  type MessageId,
  NativeItemIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";

type Adapter = ReturnType<typeof createReplayAdapter>;
export function attachPeer(adapter: Adapter, state: string) {
  const caps = adapter.capabilities,
    invoke = adapter.invoke,
    events = adapter.events;
  const tickets = new Map<AttemptId, { deliveryId: DeliveryId; messageId: MessageId }>();

  const proofs = new Map<AttemptId, ReturnType<typeof v.parse<typeof NativeItemIdSchema>>>();
  const url = readFileSync(join(state, "peer.url"), "utf8");
  async function observe(
    step: string,
    attemptId: AttemptId,
    deliveryId: DeliveryId,
    messageId: MessageId,
    sessionId: string | null,
    data: unknown,
  ) {
    const res = await fetch(url, {
      method: "POST",
      body: JSON.stringify({ step, attemptId, deliveryId, messageId, sessionId, data }),
    });
    if (!res.ok) throw Error("Peer observation failed");
    return v.parse(v.object({ itemId: NativeItemIdSchema }), await res.json()).itemId;
  }
  adapter.capabilities = async (instance) => {
    const reply = await caps(instance);
    if (reply.kind === "ok") {
      reply.value.steering = {
        ...reply.value.steering,
        insertCurrent: { support: { kind: "native" }, readReceipt: "yes", accepts: ["text"] },
      };
      if (existsSync(join(state, "dedup")))
        reply.value.input = { receipt: "proof", query: "none", deduplicate: "acrossRestart" };
    }
    return reply;
  };
  const open = adapter.open;
  adapter.open = (args) => open({ ...args, resume: null });
  adapter.invoke = (async (...args: Parameters<typeof invoke>) => {
    const [session, , command] = args;
    if (command.kind === "steer") {
      await observe(
        "steer",
        command.attemptId,
        command.deliveryId,
        command.input.id,
        session.nativeSessionId,
        command,
      );
      return { kind: "ok", value: { kind: "written", deliveryId: command.deliveryId } };
    }
    if (command.kind === "service" && command.request.kind === "handoff") {
      await observe(
        "handoff",
        session.handle.attemptId,
        command.deliveryId,
        command.request.messageIds[0]!,
        session.nativeSessionId,
        command.request,
      );
      return { kind: "ok", value: { kind: "service", result: null } };
    }
    if (command.kind === "deliverInput") {
      tickets.set(command.attemptId, {
        messageId: command.input.id,
        deliveryId: command.deliveryId,
      });
      const proof = await observe(
        "write",
        command.attemptId,
        command.deliveryId,
        command.input.id,
        session.nativeSessionId,
        command.input,
      );
      proofs.set(command.attemptId, proof);
    }
    return invoke(...args);
  }) as typeof invoke;
  adapter.events = async function* (session, after) {
    for await (const event of events(session, after)) {
      const p = event.payload;
      if (p.kind !== "roundStarted") {
        yield event;
        if (p.kind === "roundEnded") {
          const ticket = tickets.get(p.attemptId);
          if (!ticket) throw Error("Missing ending delivery");
          await observe(
            "ended",
            p.attemptId,
            ticket.deliveryId,
            ticket.messageId,
            event.sessionId,
            null,
          );
        }
        continue;
      }
      const t = tickets.get(p.attemptId);
      const proof = proofs.get(p.attemptId);
      if (!t || !proof) throw Error("Missing peer evidence");
      yield {
        ...event,
        eventId: "receipt-" + t.deliveryId,
        payload: {
          kind: "deliveryReceived",
          attemptId: p.attemptId,
          deliveryId: t.deliveryId,
          receipt: { kind: "input", sessionId: event.sessionId, itemId: proof },
        },
      };
      yield event;
      await observe("start", p.attemptId, t.deliveryId, t.messageId, event.sessionId, p);
      for (;;) {
        const res = await fetch(url + "/turn", {
          method: "POST",
          body: JSON.stringify({
            step: "turn",
            ...t,
            attemptId: p.attemptId,
            sessionId: event.sessionId,
            data: null,
          }),
        });
        if (!res.ok) throw Error("Missing input peer turn");
        const action = v.parse(turnAction, await res.json());
        if (action.kind === "resume") break;
        if (action.kind === "late") {
          const { source } = action;
          yield {
            ...event,
            eventId: "late-" + source.deliveryId,
            payload: {
              kind: "deliveryReceived",
              attemptId: source.attemptId,
              deliveryId: source.deliveryId,
              receipt: {
                kind: "input",
                sessionId: source.sessionId,
                itemId: v.parse(NativeItemIdSchema, "native-" + source.deliveryId),
              },
            },
          };
          await observe(
            "lateApplied",
            source.attemptId,
            source.deliveryId,
            source.messageId,
            source.sessionId,
            null,
          );
        } else {
          yield {
            ...event,
            eventId: "read-" + action.messageId,
            payload: { kind: "steerRead", attemptId: p.attemptId, messageId: action.messageId },
          } satisfies AdapterEventEnvelope<"replay">;
          await observe(
            "steerApplied",
            p.attemptId,
            action.deliveryId,
            action.messageId,
            event.sessionId,
            null,
          );
        }
      }
    }
  };
  return async function waitForClaim() {
    const res = await fetch(url + "/claim");
    if (!res.ok) throw Error("Input peer claim gate failed");
  };
}
