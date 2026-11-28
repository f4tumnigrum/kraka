import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  NativeItemIdSchema,
} from "@kraka/protocol";
import type { AcpTransport, AcpConnection } from "./acp";
import { AcpDuplex } from "./rpc";
import { translateAcpFrame } from "./translate";
import { decodeAcpLines } from "./transport";

test("Two directions may use the same RPC ID", async () => {
  let input!: ReadableStreamDefaultController<unknown>;
  const inbox = new ReadableStream<unknown>({
    start(controller) {
      input = controller;
    },
  });
  const conn = { connection: {} };
  const sent: unknown[] = [];
  const transport: AcpTransport<AcpConnection> = {
    open: async () => ({ kind: "ok", value: conn }),
    send: async (_c, f) => {
      sent.push(f);
      return { kind: "ok", value: undefined };
    },
    async *frames() {
      let n = 0;
      for await (const frame of inbox) yield { cursor: String(++n), frame };
    },
    close: async () => {
      input.close();
      return { kind: "ok", value: undefined };
    },
  };
  const rpc = new AcpDuplex(transport, conn);
  const reverse = Promise.withResolvers<void>();
  rpc.onCall = (c) => {
    void rpc.reply(c.id, { result: { selected: "once" } }).then(reverse.resolve, reverse.reject);
    return true;
  };
  const numeric = rpc.request("numeric", {}, { id: 3 });
  const string = rpc.request("string", {}, { id: "3" });
  input.enqueue({ jsonrpc: "2.0", method: "reverse", params: {}, id: 3 });
  await reverse.promise;
  input.enqueue({ jsonrpc: "2.0", result: "string reply", id: "3" });
  input.enqueue({ jsonrpc: "2.0", result: "numeric reply", id: 3 });
  expect(await numeric.reply).toMatchObject({ id: 3, result: "numeric reply" });
  expect(await string.reply).toMatchObject({ id: "3", result: "string reply" });
  expect(sent[2]).toEqual({ jsonrpc: "2.0", id: 3, result: { selected: "once" } });
  await rpc.close();
  await rpc.reader;
});
test("A late prompt result keeps the start time absent", () => {
  const sessionId = v.parse(NativeSessionIdSchema, "session");
  const state = {
    sessionId,
    root: v.parse(NativeRootTurnIdSchema, "root"),
    itemId: v.parse(NativeItemIdSchema, "input"),
    attemptId: v.parse(AttemptIdSchema, "attempt"),
    deliveryId: v.parse(DeliveryIdSchema, "delivery"),
    cancelled: false,
    ended: false,
  };
  const first = translateAcpFrame({ stopReason: "end_turn", observedAt: 123 }, state);
  const again = translateAcpFrame({ stopReason: "end_turn", observedAt: 127 }, first.state);
  expect([...first.events, ...again.events].map((e) => e.kind)).toEqual([
    "deliveryReceived",
    "roundEnded",
  ]);
  expect(first.events[1]).toMatchObject({
    endedAt: 123,
    endTimeEvidence: { source: "environmentObserved", environmentObservedAt: 123 },
    outcome: { reason: "completed" },
  });
});
test("A partial final line reports a protocol failure", async () => {
  const bytes = Buffer.from('"苔"\r\n{"partial"');
  async function* chunks() {
    yield bytes.subarray(0, 2);
    yield bytes.subarray(2);
  }
  const reader = decodeAcpLines(chunks());
  expect(await reader.next()).toEqual({ value: "苔", done: false });
  await expect(reader.next()).rejects.toThrow("Partial final ACP frame");
});
