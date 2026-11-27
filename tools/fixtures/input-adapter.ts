import { existsSync, readFileSync, rmSync } from "node:fs";
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
  const reads = new Map<AttemptId, MessageId[]>();
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
      const pending = reads.get(command.attemptId) ?? [];
      pending.push(command.input.id);
      reads.set(command.attemptId, pending);
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
      while (existsSync(join(state, "hold-turn"))) {
        const late = join(state, "inject-late");
        if (existsSync(late)) {
          const source = JSON.parse(readFileSync(late, "utf8"));
          rmSync(late);
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
        }
        for (const messageId of reads.get(p.attemptId)?.splice(0) ?? []) {
          yield {
            ...event,
            eventId: "read-" + messageId,
            payload: { kind: "steerRead", attemptId: p.attemptId, messageId },
          } satisfies AdapterEventEnvelope<"replay">;
        }
        await Bun.sleep(3);
      }
    }
  };
}
