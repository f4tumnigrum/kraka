import type { ConnectionId, ContentTransferId } from "./ids";
import type { FlowWindow, TransportFrame } from "./transport";
import { TRANSPORT_LIMITS as limits } from "./transport-limits";

interface Received {
  received: number;
  consumed: number;
  transfer: { id: ContentTransferId; length: number; position: number } | null;
}

/** Positions on the stream count complete encoded frames. Chunk offsets count payload bytes in one transfer. */
export class FlowReceiver {
  private readonly streams = new Map<number, Received>();
  private highest = 0;
  private controlOffset = 0;
  constructor(readonly epoch: ConnectionId) {}
  open(id: number) {
    if (
      id !== this.highest + 1 ||
      id > 2_147_483_647 ||
      this.streams.size >= limits.maxActiveDataStreams
    )
      throw new Error("Invalid receive stream");
    this.highest = id;
    this.streams.set(id, { received: 0, consumed: 0, transfer: null });
  }
  declare(id: number, transferId: ContentTransferId, length: number) {
    const stream = this.streams.get(id);
    if (!stream || stream.transfer || !Number.isSafeInteger(length) || length <= 0)
      throw new Error("Unexpected transfer declaration");
    stream.transfer = { id: transferId, length, position: 0 };
  }
  receive(frame: Exclude<TransportFrame, FlowWindow>, size: number) {
    if (frame.epoch !== this.epoch) throw new Error("Unexpected epoch");
    if (frame.lane === "control") {
      if (frame.offsetBytes !== this.controlOffset) throw new Error("Control offset gap");
      this.controlOffset += size;
      return;
    }
    const s = this.streams.get(frame.streamId);
    if (
      !s ||
      s.received !== frame.offsetBytes ||
      s.received + size > s.consumed + limits.initialFlowWindowBytes
    )
      throw new Error("Unexpected data position");
    const transfer = s.transfer;
    if ("payload" in frame) {
      if (
        !transfer ||
        transfer.id !== frame.message.transferId ||
        transfer.position !== frame.message.offsetBytes ||
        transfer.position + frame.payload.length > transfer.length
      )
        throw new Error("Unexpected content chunk");
      transfer.position += frame.payload.length;
      if (transfer.position === transfer.length) s.transfer = null;
    } else if (transfer) throw new Error("Interrupted transfer");
    s.received += size;
  }
  consume(streamId: number, bytes: number): FlowWindow {
    const s = this.streams.get(streamId);
    if (!s || !Number.isSafeInteger(bytes) || bytes < 0 || s.consumed + bytes > s.received)
      throw new Error("Cannot acknowledge unread bytes");
    s.consumed += bytes;
    return {
      lane: "window",
      epoch: this.epoch,
      streamId,
      consumedBytes: s.consumed,
      limitBytes: s.consumed + limits.initialFlowWindowBytes,
    };
  }
  cancel(id: number) {
    this.streams.delete(id);
  }
  close() {
    this.streams.clear();
  }
}
