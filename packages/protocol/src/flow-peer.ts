import type { ConnectionId } from "./ids";
import {
  decodeFrame,
  InvalidStreamFrame,
  wireBytes,
  type Utf8,
  type WireMessage,
} from "./stream-codec";
import { FlowSender } from "./stream-flow";
import { FlowReceiver } from "./stream-receiver";
import type { ControlMessage, FlowWindow, TransportFrame } from "./transport";

export interface FlowPort {
  utf8: Utf8;
  now(): number;
  write(data: WireMessage): number;
  beforeSend?(): void;
  sentControl?(message: ControlMessage): void;
}
export interface FrameSink {
  control(message: ControlMessage): void;
  data(frame: Extract<TransportFrame, { lane: "data" }>, size: number): void;
  discarded(id: number): void;
}
export class FlowPeer {
  readonly send: FlowSender;
  readonly receive: FlowReceiver;
  private blocked = false;
  private closed = false;
  constructor(
    readonly epoch: ConnectionId,
    readonly port: FlowPort,
    private readonly sink: FrameSink,
  ) {
    this.send = new FlowSender(epoch, port.utf8, port.sentControl);
    this.receive = new FlowReceiver(epoch);
  }
  control(message: ControlMessage | FlowWindow) {
    if (!this.send.control(message)) throw new Error("Control queue full or closed");
  }
  input(data: WireMessage) {
    if (this.closed) return;
    let frame: TransportFrame;
    try {
      frame = decodeFrame(data, this.port.utf8);
    } catch (error) {
      if (!(error instanceof InvalidStreamFrame) || error.epoch !== this.epoch) throw error;
      this.discard(error.streamId);
      return;
    }
    if (frame.epoch !== this.epoch) throw new Error("Unexpected connection epoch");
    if (frame.lane === "window") {
      if (this.send.window(frame, this.port.now()) === "failure")
        throw new Error("Invalid send window");
      return;
    }
    const size = wireBytes(data, this.port.utf8);
    if (frame.lane === "control") {
      this.receive.receive(frame, size);
      const message = frame.message;
      if (message.kind === "stream.reset") this.send.end(message.streamId, "clientClosed");
      this.sink.control(message);
    } else {
      try {
        this.receive.receive(frame, size);
        this.sink.data(frame, size);
      } catch {
        this.discard(frame.streamId);
      }
    }
  }
  private discard(id: number) {
    this.receive.cancel(id);
    this.sink.discarded(id);
    this.control({ kind: "stream.reset", streamId: id, reason: "contentChanged" });
  }
  pump(maxFrames = 32) {
    // A timer may expire a subscription even when the socket is waiting for drain.
    this.port.beforeSend?.();
    this.send.expire(this.port.now());
    for (let n = 0; n < maxFrames && !this.closed && !this.blocked; n++) {
      if (n) this.port.beforeSend?.();
      const reservation = this.send.next(this.port.now());
      if (!reservation) return false;
      const status = this.port.write(reservation.wire);
      if (status !== 0) this.send.accepted(reservation, this.port.now());
      this.blocked = status <= 0;
    }
    return !this.closed && !this.blocked;
  }
  drain() {
    this.blocked = false;
    return this.pump();
  }
  close() {
    this.closed = true;
    this.send.close();
    this.receive.close();
  }
}
