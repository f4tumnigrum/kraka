import * as v from "valibot";
import { FlowPeer, type FlowPort } from "./flow-peer";
import { binarySource, OversizedControlFrame, type WireMessage } from "./stream-codec";
import { type ConnectionId, ContentTransferIdSchema, SubscriptionIdSchema } from "./ids";
import { ControlMessageSchema, type ControlMessage } from "./transport";

/** Multiplex authorized logical messages that exceed one control frame. */
export class ControlStream {
  private readonly flow: FlowPeer;
  private readonly incoming = new Map<
    number,
    { length: number; parts: Uint8Array[]; received: number }
  >();
  private readonly outgoing = new Map<number, { complete: boolean }>();
  constructor(
    epoch: ConnectionId,
    private readonly port: FlowPort,
    private readonly authorized: () => boolean,
    receive: (value: ControlMessage) => void,
  ) {
    this.flow = new FlowPeer(epoch, port, {
      control: (message) => {
        if (message.kind !== "transport.content") {
          receive(message);
          return;
        }
        if (!authorized()) throw Error("Unauthenticated content stream");
        this.flow.receive.open(message.streamId);
        this.flow.receive.declare(message.streamId, message.transferId, message.byteLength);
        this.incoming.set(message.streamId, { length: message.byteLength, received: 0, parts: [] });
      },
      data: (frame, size) => {
        const pending = this.incoming.get(frame.streamId);
        if (!pending || !("payload" in frame) || !authorized()) throw Error("Unexpected content");
        pending.parts.push(frame.payload);
        pending.received += frame.payload.length;
        this.flow.control(this.flow.receive.consume(frame.streamId, size));
        if (pending.received !== pending.length) return;
        this.incoming.delete(frame.streamId);
        this.flow.receive.cancel(frame.streamId);
        const bytes = new Uint8Array(pending.length);
        let position = 0;
        for (const part of pending.parts) {
          bytes.set(part, position);
          position += part.length;
        }
        const msg = v.parse(ControlMessageSchema, JSON.parse(port.utf8.decode(bytes)));
        if (
          msg.kind !== "signedRequest" &&
          msg.kind !== "accepted" &&
          msg.kind !== "rejected" &&
          msg.kind !== "programError"
        )
          throw Error("Unexpected logical control message");
        receive(msg);
      },
      discarded: (id) => {
        this.incoming.delete(id);
        throw Error("Invalid logical control stream");
      },
    });
  }
  input(wire: WireMessage) {
    this.flow.input(wire);
    for (const [id, source] of this.outgoing)
      if (source.complete && this.flow.send.releaseConsumed(id)) this.outgoing.delete(id);
    this.flow.pump();
  }
  send(message: ControlMessage) {
    const utf8 = this.port.utf8;
    try {
      this.flow.control(message);
    } catch (error) {
      if (
        !(error instanceof OversizedControlFrame) ||
        !this.authorized() ||
        !(
          message.kind === "signedRequest" ||
          message.kind === "accepted" ||
          message.kind === "rejected" ||
          message.kind === "programError"
        )
      )
        throw error;
      const bytes = utf8.encode(JSON.stringify(message));
      const transferId = v.parse(ContentTransferIdSchema, "content-" + ++this.serial);
      const source = { complete: false };
      const streamId = this.flow.send.open(
        v.parse(SubscriptionIdSchema, transferId),
        (offset, size) => pull(offset, size),
        (frame) => {
          if (
            frame.lane === "data" &&
            frame.message.kind === "content.chunk" &&
            frame.message.offsetBytes + frame.message.byteLength === bytes.length
          )
            source.complete = true;
        },
      );
      const pull = binarySource({
        epoch: this.flow.epoch,
        streamId,
        transferId,
        length: bytes.length,
        utf8,
        read: (pos, n) => bytes.subarray(pos, pos + n),
      });
      this.outgoing.set(streamId, source);
      this.flow.control({
        kind: "transport.content",
        streamId,
        transferId,
        encoding: "utf8Json",
        byteLength: bytes.length,
      });
    }
    this.flow.pump();
  }
  private serial = 0;
  close() {
    this.incoming.clear();
    this.outgoing.clear();
    this.flow.close();
  }
}
