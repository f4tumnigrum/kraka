import * as v from "valibot";
import {
  binarySource,
  ContentTransferIdSchema,
  TRANSPORT_LIMITS,
  wireBytes,
  type DataMessage,
  type FlowPeer,
  type GitStatus,
  type PullFrame,
  type SubscriptionId,
  type TransportFrame,
} from "@kraka/protocol";

type ActiveMessage = {
  message: Extract<DataMessage, { kind: "git.status" }>;
  bytes: Uint8Array;
  chunk: PullFrame | null;
  chunkEnd: boolean;
  finalOffset: number | null;
};

export class GitStatusStream {
  readonly id: number;
  private pending: GitStatus | null = null;
  private active: ActiveMessage | null = null;

  constructor(
    private readonly peer: FlowPeer,
    readonly subscriptionId: SubscriptionId,
    private readonly wake: () => void,
    private readonly released: () => void,
  ) {
    this.id = peer.send.open(
      subscriptionId,
      (offset, capacity) => this.pull(offset, capacity),
      (frame) => this.accepted(frame),
      () => this.dispose(),
    );
  }

  publish(snapshot: GitStatus) {
    this.pending = snapshot;
    this.wake();
  }

  end(reason: "authorizationRevoked" | "clientClosed" | "backlogExceeded") {
    this.peer.send.end(this.id, reason);
    this.wake();
  }

  private pull(offset: number, capacity: number): Extract<TransportFrame, { lane: "data" }> | null {
    if (!this.active) {
      const snapshot = this.pending;
      if (!snapshot) return null;
      this.pending = null;
      const message: DataMessage = {
        kind: "git.status",
        subscriptionId: this.subscriptionId,
        snapshot,
      };
      this.active = {
        message,
        bytes: this.peer.port.utf8.encode(JSON.stringify(message)),
        chunk: null,
        chunkEnd: false,
        finalOffset: null,
      };
    }
    const active = this.active;
    if (!active) return null;
    if (active.finalOffset !== null) return null;
    const frame: Extract<TransportFrame, { lane: "data" }> = {
      lane: "data",
      epoch: this.peer.epoch,
      streamId: this.id,
      offsetBytes: offset,
      message: active.message,
    };
    const frameSize = wireBytes(JSON.stringify(frame), this.peer.port.utf8);
    if (frameSize <= TRANSPORT_LIMITS.maxDataChunkBytes) {
      if (frameSize > capacity) return null;
      active.finalOffset = offset;
      return frame;
    }
    if (!active.chunk) {
      const transferId = v.parse(ContentTransferIdSchema, crypto.randomUUID());
      this.peer.control({
        kind: "transport.content",
        transferId,
        streamId: this.id,
        encoding: "utf8Json",
        byteLength: active.bytes.length,
      });
      active.chunk = binarySource({
        epoch: this.peer.epoch,
        streamId: this.id,
        transferId,
        length: active.bytes.length,
        utf8: this.peer.port.utf8,
        read: (start, length) => {
          active.chunkEnd = start + length === active.bytes.length;
          return active.bytes.subarray(start, start + length);
        },
      });
    }
    const chunk = active.chunk(offset, capacity);
    if (chunk && active.chunkEnd) active.finalOffset = offset;
    return chunk;
  }

  private accepted(frame: TransportFrame) {
    const active = this.active;
    if (!active || frame.lane !== "data" || frame.offsetBytes !== active.finalOffset) return;
    this.active = null;
    if (this.pending) this.wake();
  }

  private dispose() {
    this.released();
    this.active = null;
    this.pending = null;
  }
}
