import {
  readPrivateSecretRequest,
  type PrivateSecretRequest,
  type CommandReceipt,
  type SignedRequest,
  type SessionAuthorized,
} from "./requests";
import * as v from "valibot";
import { ContentTransferIdSchema, SubscriptionIdSchema } from "./ids";
import { binarySource } from "./stream-codec";
import { ControlMessageSchema, type ControlMessage, type TransportFrame } from "./transport";
import { TRANSPORT_LIMITS } from "./transport-limits";
import type { FlowPeer } from "./flow-peer";

// Large signed requests remain one logical control message, with independent byte credit.
export function sendLogicalRequest(
  peer: FlowPeer,
  request: SignedRequest | PrivateSecretRequest | CommandReceipt,
) {
  const utf8 = peer.port.utf8;
  const data = utf8.encode(JSON.stringify(request));
  if (
    !(request.kind === "signedRequest" && request.method === "todo.submitSecret") &&
    data.length + utf8.encode(peer.epoch).length + 88 <= TRANSPORT_LIMITS.maxControlFrameBytes
  ) {
    peer.control(request);
    return;
  }
  return sendLogicalContent(peer, data, request.commandId);
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
  return id;
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
  protected readContent(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
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
    const value: unknown = JSON.parse(this.peer.port.utf8.decode(bytes));
    return { value, transferId: f.message.transferId };
  }
  read(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
    const content = this.readContent(f, size);
    return content ? v.parse(ControlMessageSchema, content.value) : null;
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
  data(
    frame: Extract<TransportFrame, { lane: "data" }>,
    size: number,
    features: SessionAuthorized["features"] = [],
  ) {
    const content = this.readContent(frame, size);
    if (!content) return null;
    const { value, transferId } = content;
    if (
      value &&
      typeof value === "object" &&
      "method" in value &&
      value.method === "todo.submitSecret"
    ) {
      const parsed = readPrivateSecretRequest(value, features);
      if (parsed.kind !== "request" || parsed.request.commandId !== String(transferId))
        throw Error("Invalid confidential request");
      return parsed.request;
    }
    const message = v.parse(ControlMessageSchema, value);
    if (message.kind !== "signedRequest" || message.commandId !== String(transferId))
      throw Error("Invalid logical request binding");
    return message;
  }
}
