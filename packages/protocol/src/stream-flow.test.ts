import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  FlowPeer,
  FlowSender,
  FlowReceiver,
  applyWindow,
  binarySource,
  ConnectionIdSchema,
  SubscriptionIdSchema,
  ContentTransferIdSchema,
  SubscriptionPageSchema,
  PreviewFrameAckSchema,
  decodeFrame,
  encodeFrame,
  TRANSPORT_LIMITS,
  wireBytes,
  type FlowWindow,
} from "./index";
const epoch = v.parse(ConnectionIdSchema, "epoch"),
  sub = v.parse(SubscriptionIdSchema, "a"),
  transferId = v.parse(ContentTransferIdSchema, "x");
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
const utf8 = {
  encode: (s: string) => encoder.encode(s),
  decode: (b: Uint8Array) => decoder.decode(b),
};
function open(
  s: FlowSender,
  id: number,
  read = (pos: number, n: number) => new Uint8Array(n).fill(pos % 255),
) {
  return s.open(sub, binarySource({ epoch, streamId: id, transferId, length: 20000, read, utf8 }));
}
function flush(s: FlowSender, now: number) {
  const result = [];
  for (let w = s.next(now); w; w = s.next(now)) {
    result.push(w.frame);
    s.accepted(w, now);
  }
  return result;
}
const window = (streamId: number, consumedBytes: number): FlowWindow => ({
  lane: "window",
  epoch,
  streamId,
  consumedBytes,
  limitBytes: 4096 + consumedBytes,
});
test("duplicate windows grant no new bytes and only consumption on the waiting stream renews its deadline", () => {
  const s = new FlowSender(epoch, utf8);
  open(s, 1);
  open(s, 2);
  flush(s, 0);
  expect(s.snapshot(1)).toMatchObject({ sentBytes: 4096, consumedBytes: 0, deadline: 15000 });
  expect(s.window(window(1, 0), 14999)).toBe("stale");
  expect(s.window(window(2, 4096), 14999)).toBe("updated");
  expect(s.window(window(2, 4096), 14999)).toBe("stale");
  s.control({ kind: "transport.probe", serial: 1 });
  expect(flush(s, 14999)[0]).toMatchObject({ message: { kind: "transport.probe" } });
  expect(s.snapshot(2)).toMatchObject({ sentBytes: 8192, limitBytes: 8192, deadline: 29999 });
  expect(flush(s, 15000)).toMatchObject([
    { message: { kind: "subscription.ended", reason: "acknowledgementTimeout" } },
  ]);
  expect(s.snapshot(1)).toBeUndefined();
  expect(s.snapshot(2)?.deadline).toBe(29999);
  expect(s.window(window(2, 8096), 29998)).toBe("updated");
  expect(s.snapshot(2)?.deadline).toBe(44998);
  s.window(window(2, 8192), 30000);
  expect(s.snapshot(2)?.deadline).toBeNull();
});
test("partial consumption at 14,999 renews the deadline, with no timer after full consumption", () => {
  const s = new FlowSender(epoch, utf8);
  open(s, 1);
  flush(s, 0);
  expect(s.window({ ...window(1, 1), limitBytes: 4096 }, 14999)).toBe("updated");
  expect(s.snapshot(1)?.deadline).toBe(29999);
  expect(flush(s, 15000)).toEqual([]);
  s.window({ ...window(1, 4096), limitBytes: 4096 }, 29998);
  expect(s.snapshot(1)?.deadline).toBeNull();
  expect(flush(s, 60000)).toEqual([]);
});
test("a full data budget leaves room for control and stops the next producer before pulling", () => {
  const s = new FlowSender(epoch, utf8);
  for (let id = 1; id <= 14; id++) {
    open(s, id);
    for (let n = 0; n < 4; n++) expect(s.reserve(id)).toBe(true);
  }
  let calls = 0;
  open(s, 15, (_, n) => {
    calls++;
    return new Uint8Array(n);
  });
  expect(s.pending.data).toBe(57344);
  expect(s.reserve(15)).toBe(false);
  expect(calls).toBe(0);
  s.control({ kind: "transport.probe", serial: 1 });
  expect(s.next(0)?.frame.lane).toBe("control");
  s.end(1, "backlogExceeded");
  s.end(1, "backlogExceeded");
  expect(s.pending.data).toBe(57344 - 4096);
  expect(s.reserve(15)).toBe(true);
  expect(calls).toBe(1);
  s.close();
  expect(s.pending).toEqual({ control: 0, data: 0 });
});
test("a versioned text return on B uses B's credit while preview acknowledgements cannot grant A credit", () => {
  const s = new FlowSender(epoch, utf8);
  open(s, 1);
  flush(s, 0);
  const preview = v.parse(PreviewFrameAckSchema, {
    address: {
      environmentId: "e",
      environmentGeneration: "00000000-0000-4000-a000-000000000001",
      threadId: "t",
      host: { kind: "environmentBrowser" },
      hostGeneration: "h",
      tabId: "00000000-0000-4000-a000-000000000002",
    },
    subscriptionId: "a",
    through: "2",
  });
  const a = s.snapshot(1);
  if (!a) throw Error("Missing A");
  for (const invalid of [
    preview,
    { ...window(1, 4096), epoch: "old" },
    window(2, 4096),
    window(1, 4097),
    { ...window(1, 4096), limitBytes: 99999 },
  ])
    expect(applyWindow(a, invalid, 100).kind).toBe("failure");
  const page = v.parse(SubscriptionPageSchema, {
    kind: "subscription.page",
    subscriptionId: "b",
    passId: "p",
    through: {
      environmentId: "e",
      databaseGeneration: "d",
      visibilityGeneration: "v",
      scope: { kind: "thread", threadId: "t" },
      shapeVersion: 1,
      through: "2",
    },
    pageNumber: 0,
    pageCount: 1,
    changes: [
      {
        kind: "handoff.textReturned",
        version: "2",
        result: {
          kind: "textReturned",
          transferId: "x",
          source: { environmentId: "e", threadId: "child", roundId: "r" },
          target: { environmentId: "e", threadId: "t" },
          text: "hello",
          history: { coverage: "unknown", omittedItems: null },
          input: { messageId: "m", roundId: "r", attemptId: "a", deliveryId: "d" },
        },
      },
    ],
  });
  let available = true;
  s.open(page.subscriptionId, (offsetBytes) => {
    if (!available) return null;
    available = false;
    return { lane: "data", epoch, streamId: 2, offsetBytes, message: page };
  });
  expect(flush(s, 100)).toMatchObject([{ streamId: 2, message: page }]);
  expect(s.snapshot(2)?.sentBytes).toBeGreaterThan(0);
  expect(s.snapshot(1)).toEqual(a);
  expect(s.window(window(1, 4096), 101)).toBe("updated");
  expect(flush(s, 101).length).toBeGreaterThan(0);
});
test("oversized encoded chunks, gaps, bad transfer IDs and malformed lengths never deliver payload", () => {
  const sender = new FlowSender(epoch, utf8);
  open(sender, 1);
  const next = sender.next(0);
  if (!next || !("payload" in next.frame) || typeof next.wire === "string")
    throw Error("Expected binary");
  const f = next.frame;
  expect(() =>
    encodeFrame(
      { ...f, payload: new Uint8Array(1024), message: { ...f.message, byteLength: 1024 } },
      utf8,
    ),
  ).toThrow();
  expect(decodeFrame(next.wire, utf8)).toEqual(f);
  expect(() => decodeFrame(next.wire.slice(0, 100), utf8)).toThrow();
  const receiver = new FlowReceiver(epoch);
  receiver.open(1);
  receiver.declare(1, transferId, 20000);
  for (const bad of [
    { ...f, streamId: 2 },
    { ...f, offsetBytes: 1 },
    { ...f, message: { ...f.message, offsetBytes: 2 } },
    { ...f, message: { ...f.message, transferId: v.parse(ContentTransferIdSchema, "other") } },
  ])
    expect(() => receiver.receive(bad, next.size)).toThrow();
  receiver.receive(f, next.size);
  expect(receiver.consume(1, next.size).consumedBytes).toBe(wireBytes(next.wire, utf8));
  expect(next.size).toBe(TRANSPORT_LIMITS.maxDataChunkBytes);
});
test("a queued Bun write counts once, an unsent reservation survives until drain", () => {
  const writes: number[] = [];
  const statuses = [0, -1, 1];
  const peer = new FlowPeer(
    epoch,
    {
      utf8,
      now: () => 0,
      write: (data) => {
        writes.push(wireBytes(data, utf8));
        return statuses.shift() ?? 1;
      },
    },
    { data() {}, control() {}, discarded() {} },
  );
  open(peer.send, 1);
  peer.pump();
  peer.pump();
  expect(writes.length).toBe(1);
  expect(peer.send.snapshot(1)).toMatchObject({ sentBytes: 0, reservedBytes: 1024 });
  peer.drain();
  peer.pump();
  expect(writes.length).toBe(2);
  expect(peer.send.snapshot(1)).toMatchObject({ sentBytes: 1024, reservedBytes: 0 });
  peer.drain();
  expect(peer.send.snapshot(1)?.sentBytes).toBe(4096);
  peer.close();
  expect(peer.send.pending.data).toBe(0);
});
