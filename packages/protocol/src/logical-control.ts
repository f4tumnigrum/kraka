import * as v from "valibot";
import { ContentTransferIdSchema, SubscriptionIdSchema } from "./ids";
import { binarySource } from "./stream-codec";
import { ControlMessageSchema, type ControlMessage, type TransportFrame } from "./transport";
import { TRANSPORT_LIMITS } from "./transport-limits";
import type { FlowPeer } from "./flow-peer";

// Large signed requests remain one logical control message, with independent byte credit.
export function sendLogicalRequest(
  peer: FlowPeer,
  request: Extract<ControlMessage, { kind: "signedRequest" }>,
) {
  const utf8 = peer.port.utf8;
  const data = utf8.encode(JSON.stringify(request));
  if (data.length + utf8.encode(peer.epoch).length + 88 <= TRANSPORT_LIMITS.maxControlFrameBytes) {
    peer.control(request);
    return;
  }
  const transferId = v.parse(ContentTransferIdSchema, request.commandId);
  let pull: ReturnType<typeof binarySource>;
  const id = peer.send.open(
    v.parse(SubscriptionIdSchema, request.commandId),
    (offset, capacity) => pull(offset, capacity),
    (frame) => {
      if ("payload" in frame && frame.message.offsetBytes + frame.payload.length === data.length)
        peer.send.finish(id);
    },
  );
  pull = binarySource({
    epoch: peer.epoch,
    streamId: id,
    transferId,
    length: data.length,
    utf8,
    read: (offset, n) => data.subarray(offset, offset + n),
  });
  peer.control({
    kind: "transport.content",
    streamId: id,
    transferId,
    encoding: "utf8Json",
    byteLength: data.length,
  });
}
export class RequestUploads {
  private streams = new Map<number, { parts: Uint8Array[]; length: number; received: number }>();
  private allocated = 0;
  constructor(private peer: FlowPeer) {}
  declare(m: Extract<ControlMessage, { kind: "transport.content" }>) {
    if (m.byteLength < 1 || this.allocated + m.byteLength > TRANSPORT_LIMITS.maxPendingDataBytes)
      throw Error("Request staging capacity exceeded");
    this.peer.receive.open(m.streamId);
    this.peer.receive.declare(m.streamId, m.transferId, m.byteLength);
    this.streams.set(m.streamId, { parts: [], length: m.byteLength, received: 0 });
    this.allocated += m.byteLength;
  }
  data(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
    const s = this.streams.get(f.streamId);
    if (!s || !("payload" in f)) throw Error("Undeclared request");
    s.parts.push(f.payload.slice());
    s.received += f.payload.length;
    this.peer.control(this.peer.receive.consume(f.streamId, size));
    if (s.received !== s.length) return null;
    const bytes = new Uint8Array(s.length);
    let offset = 0;
    for (const part of s.parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    this.drop(f.streamId);
    const m = v.parse(ControlMessageSchema, JSON.parse(this.peer.port.utf8.decode(bytes)));
    if (m.kind !== "signedRequest" || m.commandId !== String(f.message.transferId))
      throw Error("Invalid logical request binding");
    return m;
  }
  drop(id: number) {
    const s = this.streams.get(id);
    if (s) {
      this.allocated -= s.length;
      this.streams.delete(id);
    }
    this.peer.receive.cancel(id);
  }
}
