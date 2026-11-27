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
  sendLogicalContent(peer, data, request.commandId);
}

export function sendLogicalContent(
  peer: FlowPeer,
  data: Uint8Array,
  key: string,
  onSent: (id: number) => void = (id) => peer.send.finish(id),
) {
  const transferId = v.parse(ContentTransferIdSchema, key);
  let pull: ReturnType<typeof binarySource>;
  const id = peer.send.open(
    v.parse(SubscriptionIdSchema, key),
    (offset, capacity) => pull(offset, capacity),
    (frame) => {
      if ("payload" in frame && frame.message.offsetBytes + frame.payload.length === data.length)
        onSent(id);
    },
  );
  pull = binarySource({
    epoch: peer.epoch,
    streamId: id,
    transferId,
    length: data.length,
    utf8: peer.port.utf8,
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
export class ControlContentReceiver {
  private streams = new Map<number, { parts: Uint8Array[]; length: number; received: number }>();
  private allocated = 0;
  constructor(
    private peer: FlowPeer,
    private readonly maximumBytes: number,
  ) {}
  declare(m: Extract<ControlMessage, { kind: "transport.content" }>) {
    if (m.byteLength < 1 || this.allocated + m.byteLength > this.maximumBytes)
      throw Error("Request staging capacity exceeded");
    this.peer.receive.open(m.streamId);
    this.peer.receive.declare(m.streamId, m.transferId, m.byteLength);
    this.streams.set(m.streamId, { parts: [], length: m.byteLength, received: 0 });
    this.allocated += m.byteLength;
  }
  read(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
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
    return v.parse(ControlMessageSchema, JSON.parse(this.peer.port.utf8.decode(bytes)));
  }
  clear() {
    this.streams.clear();
    this.allocated = 0;
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

export class RequestUploads extends ControlContentReceiver {
  constructor(peer: FlowPeer) {
    super(peer, TRANSPORT_LIMITS.maxPendingDataBytes);
  }
  data(frame: Extract<TransportFrame, { lane: "data" }>, size: number) {
    const message = this.read(frame, size);
    if (!message) return null;
    if (
      !("payload" in frame) ||
      message.kind !== "signedRequest" ||
      message.commandId !== String(frame.message.transferId)
    )
      throw Error("Invalid logical request binding");
    return message;
  }
}
