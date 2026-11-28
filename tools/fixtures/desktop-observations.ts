import { decodeFrame, type ControlMessage, type WireMessage } from "@kraka/protocol";

const methods: string[] = [];
const transfers = new Map<string, Uint8Array>();
const encoder = new TextEncoder(),
  decoder = new TextDecoder("utf-8", { fatal: true });
function observe(data: WireMessage) {
  const frame = decodeFrame(data, {
    encode: (t) => encoder.encode(t),
    decode: (b) => decoder.decode(b),
  });
  let m: ControlMessage;
  if (frame.lane === "control") {
    m = frame.message;
    if (m.kind === "transport.content") transfers.set(m.transferId, new Uint8Array(m.byteLength));
  } else {
    if (!("payload" in frame)) return;
    const { transferId, offsetBytes } = frame.message,
      buffer = transfers.get(transferId);
    if (!buffer) return;
    buffer.set(frame.payload, offsetBytes);
    if (offsetBytes + frame.payload.length !== buffer.length) return;
    transfers.delete(transferId);
    m = JSON.parse(decoder.decode(buffer));
  }
  if (m.kind === "signedRequest") methods.push(m.method);
}
const send = WebSocket.prototype.send;
WebSocket.prototype.send = function (data) {
  const result = send.call(this, data);
  if (typeof data === "string" || data instanceof Uint8Array) observe(data);
  return result;
};
Object.defineProperty(globalThis, "observedDesktopMethods", { get: () => methods.slice() });
