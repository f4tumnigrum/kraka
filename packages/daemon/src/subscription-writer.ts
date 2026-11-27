import {
  binarySource,
  ContentTransferIdSchema,
  TRANSPORT_LIMITS,
  wireBytes,
  subscriptionWirePage,
  type ControlMessage,
  type FlowPeer,
  type PullFrame,
  type SubscriptionId,
  type SubscriptionPage,
} from "@kraka/protocol";
import * as v from "valibot";

type Begin = Extract<ControlMessage, { kind: "subscription.begin" }>;
export interface SubscriptionPass {
  begin: Begin;
  pages: Iterable<SubscriptionPage>;
}
/** The producer owns its backlog. A false offer lets it retain and retry the next pass. */
export class SubscriptionWriter {
  readonly id: number;
  private pass: { begin: Begin; pages: Iterator<SubscriptionPage>; count: number } | null = null;
  private page: SubscriptionPage | null = null;
  private chunk: PullFrame | null = null;
  private chunkEnd = false;
  private finalOffset: number | null = null;
  constructor(
    private peer: FlowPeer,
    readonly subscriptionId: SubscriptionId,
    private wake: () => void,
  ) {
    this.id = peer.send.open(
      subscriptionId,
      (offset, capacity) => {
        const frame = this.pull(offset, capacity);
        if (
          frame &&
          (("payload" in frame && this.chunkEnd && this.page?.pageCount === this.pass?.count) ||
            (frame.message.kind === "subscription.page" &&
              frame.message.pageNumber + 1 === frame.message.pageCount))
        )
          this.finalOffset = offset;
        return frame;
      },
      (frame) => {
        if (frame.lane === "data" && frame.offsetBytes === this.finalOffset) this.seal();
      },
      () => this.release(),
    );
  }
  offer(pass: SubscriptionPass) {
    if (this.pass || !this.peer.send.snapshot(this.id)) return false;
    if (pass.begin.subscriptionId !== this.subscriptionId)
      throw new Error("Unexpected subscription");
    if (!this.peer.send.control(pass.begin)) return false;
    this.pass = { begin: pass.begin, pages: pass.pages[Symbol.iterator](), count: 0 };
    this.wake();
    return true;
  }
  end(reason: "backlogExceeded" | "clientClosed") {
    this.peer.send.end(this.id, reason);
    this.wake();
  }
  private pull(offsetBytes: number, capacity: number): ReturnType<PullFrame> {
    const p = this.pass;
    if (!p || this.finalOffset !== null) return null;
    if (this.chunkEnd) {
      this.chunk = null;
      this.chunkEnd = false;
      this.page = null;
    }
    if (this.chunk) return this.chunk(offsetBytes, capacity);
    if (!this.page) {
      const next = p.pages.next();
      if (next.done) {
        // Data reservations may still be waiting for socket acceptance.
        if (this.peer.send.snapshot(this.id)?.sentBytes !== offsetBytes) return null;
        if (p.count !== 0) throw new Error("Incomplete source page sequence");
        this.seal();
        return null;
      }
      this.page = next.value;
      p.count++;
    }
    const frame = {
      lane: "data" as const,
      epoch: this.peer.epoch,
      streamId: this.id,
      offsetBytes,
      message: this.page,
    };
    const utf8 = this.peer.port.utf8;
    const wirePage = subscriptionWirePage(this.page);
    const size = wireBytes(JSON.stringify({ ...frame, message: wirePage }), utf8);
    if (size <= TRANSPORT_LIMITS.maxDataChunkBytes) {
      if (size > capacity) return null;
      this.page = null;
      return frame;
    }
    const bytes = utf8.encode(JSON.stringify(wirePage));
    const transferId = v.parse(ContentTransferIdSchema, `page-${this.id}-${offsetBytes}`);
    this.peer.control({
      kind: "transport.content",
      transferId,
      streamId: this.id,
      encoding: "utf8Json",
      byteLength: bytes.length,
    });
    this.chunk = binarySource({
      epoch: this.peer.epoch,
      streamId: this.id,
      transferId,
      length: bytes.length,
      utf8,
      read: (offset, n) => {
        this.chunkEnd = offset + n === bytes.length;
        return bytes.subarray(offset, offset + n);
      },
    });
    this.wake();
    return null;
  }
  private seal() {
    const p = this.pass;
    if (!p) return;
    this.peer.control({
      kind: "subscription.seal",
      subscriptionId: this.subscriptionId,
      passId: p.begin.passId,
      pages: p.count,
      cursor: p.begin.through,
    });
    this.release();
    this.wake();
  }
  private release() {
    this.pass?.pages.return?.();
    this.finalOffset = null;
    this.chunk = null;
    this.chunkEnd = false;
    this.page = null;
    this.pass = null;
  }
}
