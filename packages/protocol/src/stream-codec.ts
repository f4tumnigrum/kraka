import { subscriptionWirePage } from "./list-wire";
import * as v from "valibot";
import {
  type ContentChunkHeader,
  readBinaryContent,
  TransportFrameHeaderSchema,
  type TransportFrame,
} from "./transport";
import { TRANSPORT_LIMITS } from "./transport-limits";

export interface Utf8 {
  encode(text: string): Uint8Array;
  decode(bytes: Uint8Array): string;
}
export type WireMessage = string | Uint8Array;
export function wireBytes(data: WireMessage, utf8: Utf8) {
  return typeof data === "string" ? utf8.encode(data).byteLength : data.byteLength;
}
export class OversizedControlFrame extends Error {}
export function encodeFrame(frame: TransportFrame, utf8: Utf8): WireMessage {
  if ("payload" in frame) {
    const { payload, ...header } = frame;
    const json = utf8.encode(JSON.stringify(header));
    if (!readBinaryContent(header, payload, json.length))
      throw new Error("Invalid binary frame size");
    const bytes = new Uint8Array(4 + json.length + payload.length);
    new DataView(bytes.buffer).setUint32(0, json.length);
    bytes.set(json, 4);
    bytes.set(payload, 4 + json.length);
    return bytes;
  }
  const text = JSON.stringify(
    frame.lane === "data" && frame.message.kind === "subscription.page"
      ? { ...frame, message: subscriptionWirePage(frame.message) }
      : frame,
  );
  if (wireBytes(text, utf8) > TRANSPORT_LIMITS.maxControlFrameBytes)
    throw new OversizedControlFrame("Oversized encoded frame");
  return text;
}

export class InvalidStreamFrame extends Error {
  constructor(
    readonly epoch: string,
    readonly streamId: number,
  ) {
    super("Invalid data stream frame");
  }
}

export function decodeFrame(data: WireMessage, utf8: Utf8): TransportFrame {
  const binary = typeof data !== "string";
  const size = wireBytes(data, utf8);
  if (size > TRANSPORT_LIMITS.maxDataChunkBytes || (binary && size < 6))
    throw new Error("Invalid frame length");
  const length = binary ? new DataView(data.buffer, data.byteOffset, size).getUint32(0) : 0;
  if (binary && (length < 2 || length >= size - 4)) throw new Error("Invalid binary header length");
  const raw: unknown = JSON.parse(binary ? utf8.decode(data.subarray(4, 4 + length)) : data);
  const parsed = v.safeParse(TransportFrameHeaderSchema, raw);
  if (parsed.success) {
    const header = parsed.output;
    if (header.lane !== "data") {
      if (!binary) return header;
    } else if (header.message.kind === "content.chunk") {
      if (binary) {
        const frame = readBinaryContent(header, data.subarray(4 + length), length);
        if (frame) return frame;
      }
    } else if (!binary) return { ...header, message: header.message };
  }
  if (
    raw &&
    typeof raw === "object" &&
    "lane" in raw &&
    raw.lane === "data" &&
    "epoch" in raw &&
    typeof raw.epoch === "string" &&
    "streamId" in raw &&
    Number.isSafeInteger(raw.streamId) &&
    typeof raw.streamId === "number" &&
    raw.streamId >= 1 &&
    raw.streamId <= 2147483647
  )
    throw new InvalidStreamFrame(raw.epoch, raw.streamId);
  throw new Error("Invalid transport frame");
}

export type PullFrame = (
  offset: number,
  capacity: number,
) => Extract<TransportFrame, { lane: "data" }> | null;

/** Measure the complete header before asking the source for payload bytes. */
export function binarySource(options: {
  epoch: TransportFrame["epoch"];
  streamId: number;
  transferId: ContentChunkHeader["transferId"];
  length: number;
  read: (offset: number, length: number) => Uint8Array;
  utf8: Utf8;
}): PullFrame {
  let position = 0;
  return (offsetBytes, capacity) => {
    if (position === options.length) return null;
    const message = {
      kind: "content.chunk" as const,
      transferId: options.transferId,
      offsetBytes: position,
      byteLength: 0,
      payloadEncoding: "binary" as const,
    };
    const header = {
      lane: "data" as const,
      epoch: options.epoch,
      streamId: options.streamId,
      offsetBytes,
      message,
    };
    // The zero in byteLength occupies one digit. Replace it with the final decimal length.
    const room = capacity - 4 - options.utf8.encode(JSON.stringify(header)).length + 1;
    let n = Math.min(room - 1, options.length - position);
    while (n > 0 && n + String(n).length > room) n--;
    if (n <= 0) return null;
    message.byteLength = n;
    const payload = options.read(position, n);
    if (payload.length !== n) throw new Error("Short content source");
    position += n;
    return { ...header, payload };
  };
}
