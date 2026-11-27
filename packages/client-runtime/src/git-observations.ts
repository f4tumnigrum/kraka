import * as v from "valibot";
import {
  canonicalJson,
  CommandReceiptSchema,
  DataMessageSchema,
  type FlowPeer,
  type DataMessage,
  type GitStatus,
  type SignedRequest,
  type CommandReceipt,
  type SubscriptionId,
  type TransportFrame,
  type ControlMessage,
} from "@kraka/protocol";

type Open = Extract<SignedRequest, { method: "git.subscribeStatus" }>["payload"];
export type GitStatusUpdate = { subscriptionId: SubscriptionId; snapshot: GitStatus };
type Watch = {
  open: Open;
  bound: boolean;
  current: GitStatus | null;
  pending: GitStatus | null;
  revision: number;
};
type Chunk = { bytes: Uint8Array; received: number; receipt: boolean };
export class GitObservations {
  private readonly watches = new Map<number, Watch>();
  private readonly chunks = new Map<number, Chunk>();
  constructor(
    private readonly peer: FlowPeer,
    private readonly install: (u: GitStatusUpdate) => void,
    private readonly refresh: (open: Open) => Promise<GitStatus>,
  ) {}
  open(open: Open) {
    if ([...this.watches.values()].some((w) => w.open.subscriptionId === open.subscriptionId))
      throw Error("Duplicate Git subscription");
    this.peer.receive.open(open.streamId);
    this.watches.set(open.streamId, {
      open,
      bound: false,
      current: null,
      pending: null,
      revision: 0,
    });
  }
  bind(open: Open, receipt: CommandReceipt) {
    const w = this.watches.get(open.streamId);
    if (
      !w ||
      receipt.kind !== "accepted" ||
      receipt.result.kind !== "subscriptionOpened" ||
      receipt.result.subscriptionId !== open.subscriptionId ||
      receipt.result.streamId !== open.streamId
    ) {
      this.drop(open.streamId);
      if (receipt.kind === "accepted") throw Error("Mismatched Git subscription receipt");
      return;
    }
    w.bound = true;
    if (w.pending) this.observe(w, w.pending);
    w.pending = null;
  }
  ended(id: SubscriptionId) {
    for (const [stream, w] of this.watches) if (w.open.subscriptionId === id) this.drop(stream);
  }
  drop(stream: number) {
    this.watches.delete(stream);
    this.chunks.delete(stream);
    this.peer.receive.cancel(stream);
  }
  declare(m: Extract<ControlMessage, { kind: "transport.content" }>, receipt: boolean) {
    if (!receipt && !this.watches.has(m.streamId)) return false;
    // JSON escaping can use six bytes per patch byte. Limit aggregate allocation before staging.
    const allocated = [...this.chunks.values()].reduce((sum, c) => sum + c.bytes.byteLength, 0);
    if (!m.byteLength || allocated + m.byteLength > 64 * 1024 * 1024 || this.chunks.has(m.streamId))
      throw Error("Git transfer budget exceeded");
    if (receipt) this.peer.receive.open(m.streamId);
    this.peer.receive.declare(m.streamId, m.transferId, m.byteLength);
    this.chunks.set(m.streamId, { bytes: new Uint8Array(m.byteLength), received: 0, receipt });
    return true;
  }
  data(
    f: Extract<TransportFrame, { lane: "data" }>,
    size: number,
    accept: (receipt: CommandReceipt) => void,
  ) {
    const w = this.watches.get(f.streamId),
      chunk = this.chunks.get(f.streamId);
    if (!w && !chunk) return false;
    let update: DataMessage | undefined;
    if ("payload" in f) {
      if (!chunk) throw Error("Undeclared Git transfer");
      chunk.bytes.set(f.payload, chunk.received);
      chunk.received += f.payload.length;
      this.peer.control(this.peer.receive.consume(f.streamId, size));
      if (chunk.received !== chunk.bytes.length) return true;
      this.chunks.delete(f.streamId);
      const value: unknown = JSON.parse(this.peer.port.utf8.decode(chunk.bytes));
      if (chunk.receipt) {
        this.peer.receive.cancel(f.streamId);
        const receipt = v.parse(CommandReceiptSchema, value);
        if (String(receipt.commandId) !== String(f.message.transferId))
          throw Error("Mismatched Git receipt");
        accept(receipt);
        return true;
      }
      update = v.parse(DataMessageSchema, value);
    } else {
      this.peer.control(this.peer.receive.consume(f.streamId, size));
      update = f.message;
    }
    if (!w || update.kind !== "git.status" || w.open.subscriptionId !== update.subscriptionId)
      throw Error("Mismatched Git observation");
    if (w.bound) this.observe(w, update.snapshot);
    else w.pending = update.snapshot;
    return true;
  }
  private observe(w: Watch, snapshot: GitStatus) {
    const sameTarget = canonicalJson(snapshot.target) === canonicalJson(w.open.target);
    const granularity = "granularity" in snapshot ? snapshot.granularity : snapshot.kind;
    if (w.current && snapshot.sequence < w.current.sequence) return;
    if (w.current && canonicalJson(w.current) === canonicalJson(snapshot)) return;
    const revision = ++w.revision;
    if (
      !sameTarget ||
      granularity !== w.open.granularity ||
      (w.current && snapshot.sequence !== w.current.sequence + 1)
    ) {
      w.current = null;
      void this.refresh(w.open)
        .then((fresh) => {
          if (
            this.watches.get(w.open.streamId) === w &&
            revision === w.revision &&
            canonicalJson(w.open.target) === canonicalJson(fresh.target)
          )
            this.publish(w, fresh);
        })
        .catch(() => {});
      return;
    }
    this.publish(w, snapshot);
  }
  private publish(w: Watch, snapshot: GitStatus) {
    w.current = snapshot;
    this.install({ subscriptionId: w.open.subscriptionId, snapshot });
  }
  close() {
    this.watches.clear();
    this.chunks.clear();
  }
}
