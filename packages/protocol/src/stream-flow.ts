import * as v from "valibot";
import type { ConnectionId, SubscriptionId } from "./ids";
import {
  encodeFrame,
  wireBytes,
  type PullFrame,
  type Utf8,
  type WireMessage,
} from "./stream-codec";
import {
  FlowWindowSchema,
  type ControlMessage,
  type FlowWindow,
  type TransportFrame,
} from "./transport";
import { SUBSCRIPTION_ACK_TIMEOUT_MS, TRANSPORT_LIMITS as limits } from "./transport-limits";

export interface SendStream {
  epoch: ConnectionId;
  streamId: number;
  subscriptionId: SubscriptionId;
  producedBytes: number;
  sentBytes: number;
  consumedBytes: number;
  limitBytes: number;
  reservedBytes: number;
  deadline: number | null;
}
export function applyWindow(stream: SendStream, raw: unknown, nowMs: number) {
  const result = v.safeParse(FlowWindowSchema, raw);
  if (!result.success) return { kind: "failure" } as const;
  const w: FlowWindow = result.output;
  if (
    w.epoch !== stream.epoch ||
    w.streamId !== stream.streamId ||
    w.consumedBytes > stream.sentBytes ||
    w.consumedBytes > w.limitBytes ||
    w.limitBytes - w.consumedBytes > limits.initialFlowWindowBytes
  )
    return { kind: "failure" } as const;
  if (w.consumedBytes <= stream.consumedBytes || w.limitBytes < stream.limitBytes)
    return { kind: "stale" } as const;
  const deadline =
    w.consumedBytes === stream.sentBytes ? null : nowMs + SUBSCRIPTION_ACK_TIMEOUT_MS;
  return {
    kind: "updated",
    stream: { ...stream, consumedBytes: w.consumedBytes, limitBytes: w.limitBytes, deadline },
  } as const;
}

interface Reservation {
  frame: TransportFrame;
  wire: WireMessage;
  size: number;
}
type EndReason = Extract<ControlMessage, { kind: "subscription.ended" }>["reason"];
interface Queue {
  state: SendStream;
  pull: PullFrame;
  frames: Reservation[];
  ending: EndReason | null;
  accepted?: (frame: TransportFrame) => void;
  dispose?: () => void;
}

/** One sender per direction. A socket acknowledges the reservation only after accepting its write. */
export class FlowSender {
  private readonly streams = new Map<number, Queue>();
  private readonly controls: Reservation[] = [];
  private lastId = 0;
  private lastSent = 0;
  private controlOffset = 0;
  private closed = false;
  private controlBytes = 0;
  private dataBytes = 0;
  constructor(
    readonly epoch: ConnectionId,
    readonly utf8: Utf8,
    private readonly sentControl?: (m: ControlMessage) => void,
  ) {}
  get pending() {
    return { data: this.dataBytes, control: this.controlBytes };
  }
  snapshot(id: number): Readonly<SendStream> | undefined {
    const q = this.streams.get(id);
    return q && { ...q.state };
  }
  open(
    subscriptionId: SubscriptionId,
    pull: PullFrame,
    accepted?: (frame: TransportFrame) => void,
    dispose?: () => void,
  ) {
    if (
      this.closed ||
      this.streams.size >= limits.maxActiveDataStreams ||
      this.lastId >= 2_147_483_647
    )
      throw new Error("Stream capacity exhausted");
    const streamId = ++this.lastId;
    this.streams.set(streamId, {
      state: {
        epoch: this.epoch,
        streamId,
        subscriptionId,
        producedBytes: 0,
        sentBytes: 0,
        consumedBytes: 0,
        reservedBytes: 0,
        limitBytes: limits.initialFlowWindowBytes,
        deadline: null,
      },
      pull,
      frames: [],
      ending: null,
      ...(accepted ? { accepted } : {}),
      ...(dispose ? { dispose } : {}),
    });
    return streamId;
  }
  window(w: FlowWindow, nowMs: number) {
    const q = this.streams.get(w.streamId);
    if (w.epoch !== this.epoch || w.streamId < 1 || w.streamId > this.lastId) return "failure";
    if (!q || q.ending) return "stale";
    if (q.state.deadline !== null && nowMs >= q.state.deadline) {
      this.end(w.streamId, "acknowledgementTimeout");
      return "stale";
    }
    const result = applyWindow(q.state, w, nowMs);
    if (result.kind === "updated") q.state = result.stream;
    return result.kind;
  }
  control(message: ControlMessage | FlowWindow) {
    if (this.closed) return false;
    const frame: TransportFrame =
      "lane" in message
        ? message
        : {
            lane: "control",
            epoch: this.epoch,
            streamId: 0,
            offsetBytes: this.controlOffset,
            message,
          };
    const wire = encodeFrame(frame, this.utf8);
    const size = wireBytes(wire, this.utf8);
    if (frame.epoch !== this.epoch || this.controlBytes + size > limits.maxPendingControlBytes)
      return false;
    if (frame.lane === "control") this.controlOffset += size;
    this.controls.push({ frame, wire, size });
    this.controlBytes += size;
    return true;
  }
  reserve(id: number) {
    const q = this.streams.get(id);
    if (!q || q.ending) return false;
    const s = q.state;
    const capacity = Math.min(
      limits.maxDataChunkBytes,
      limits.maxPendingDataBytes - this.dataBytes,
      s.limitBytes - s.sentBytes - s.reservedBytes,
    );
    if (capacity <= 0) return false;
    const offset = s.sentBytes + s.reservedBytes;
    this.dataBytes += capacity;
    s.reservedBytes += capacity;
    try {
      const frame = q.pull(offset, capacity);
      if (!frame || q.ending || this.closed) return false;
      if (frame.streamId !== id || frame.epoch !== this.epoch || frame.offsetBytes !== offset)
        throw new Error("Source returned a different stream or offset");
      const wire = encodeFrame(frame, this.utf8);
      const size = wireBytes(wire, this.utf8);
      if (size > capacity) throw new Error("Frame exceeds reservation");
      q.frames.push({ frame, wire, size });
      s.producedBytes += size;
      s.reservedBytes += size;
      this.dataBytes += size;
      return true;
    } finally {
      if (!q.ending && !this.closed) {
        this.dataBytes -= capacity;
        q.state.reservedBytes -= capacity;
      }
    }
  }
  withdraw(id: number) {
    const stream = this.streams.get(id);
    if (!stream) return;
    const pending = this.controls;
    const first = pending.find((r) => r.frame.lane === "control")?.frame;
    if (first?.lane !== "control") return;
    const retained = pending.filter(({ frame }) => {
      if (frame.lane !== "control") return true;
      const m = frame.message;
      return !(
        ("subscriptionId" in m && m.subscriptionId === stream.state.subscriptionId) ||
        (m.kind === "transport.content" && m.streamId === id)
      );
    });
    if (retained.length === pending.length) return;
    this.controlOffset = first.offsetBytes;
    pending.length = 0;
    this.controlBytes = 0;
    for (const { frame } of retained) {
      if (frame.lane === "control") this.control(frame.message);
      if (frame.lane === "window") this.control(frame);
    }
  }
  releaseConsumed(id: number) {
    const queue = this.streams.get(id);
    if (!queue || queue.frames.length || queue.state.consumedBytes !== queue.state.producedBytes)
      return false;
    this.finish(id);
    return true;
  }
  finish(id: number) {
    const q = this.streams.get(id);
    if (!q) return;
    this.dataBytes -= q.state.reservedBytes;
    q.dispose?.();
    this.streams.delete(id);
  }
  end(id: number, reason: EndReason) {
    const q = this.streams.get(id);
    if (!q || q.ending) return;
    q.ending = reason;
    this.dataBytes -= q.state.reservedBytes;
    q.state.reservedBytes = 0;
    q.state.deadline = null;
    q.frames.length = 0;
    q.dispose?.();
  }
  get nextDeadline() {
    let deadline = Infinity;
    for (const q of this.streams.values())
      if (q.state.deadline !== null) deadline = Math.min(deadline, q.state.deadline);
    return deadline;
  }
  expire(nowMs: number) {
    for (const [id, q] of this.streams) {
      if (q.state.deadline !== null && q.state.deadline <= nowMs)
        this.end(id, "acknowledgementTimeout");
      if (
        q.ending &&
        this.control({
          kind: "subscription.ended",
          subscriptionId: q.state.subscriptionId,
          reason: q.ending,
        })
      )
        this.streams.delete(id);
    }
  }
  next(nowMs: number): Reservation | undefined {
    this.expire(nowMs);
    if (this.controls.length) return this.controls[0];
    const ids = [...this.streams.keys()];
    const start = ids.findIndex((id) => id > this.lastSent);
    for (let i = 0; i < ids.length; i++) {
      const id = ids[(Math.max(start, 0) + i) % ids.length];
      if (id === undefined) continue;
      const q = this.streams.get(id);
      if (!q) continue;
      if (!q.frames.length) this.reserve(id);
      if (this.controls.length) return this.controls[0];
      if (q.frames.length) return q.frames[0];
    }
  }
  accepted(write: Reservation, nowMs: number) {
    if (write.frame.lane !== "data") {
      if (this.controls[0] !== write) throw new Error("Control write already released");
      this.controls.shift();
      this.controlBytes -= write.size;
      if (write.frame.lane === "control") this.sentControl?.(write.frame.message);
      return;
    }
    const q = this.streams.get(write.frame.streamId);
    if (!q || q.frames[0] !== write) throw new Error("Data write already released");
    q.frames.shift();
    q.state.sentBytes += write.size;
    q.state.reservedBytes -= write.size;
    this.dataBytes -= write.size;
    q.state.deadline ??= nowMs + SUBSCRIPTION_ACK_TIMEOUT_MS;
    this.lastSent = q.state.streamId;
    q.accepted?.(write.frame);
  }
  close() {
    this.closed = true;
    for (const q of this.streams.values()) if (!q.ending) q.dispose?.();
    this.streams.clear();
    this.controls.length = this.dataBytes = this.controlBytes = 0;
  }
}
export function nextFrame(connection: FlowSender, nowMs: number) {
  return connection.next(nowMs);
}
