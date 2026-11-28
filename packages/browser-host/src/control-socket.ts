import * as v from "valibot";
import { ControlStream, decodeFrame, ControlMessageSchema } from "@kraka/protocol";
export type SocketEvent =
  | { kind: "open" }
  | { kind: "message"; data: string | Uint8Array }
  | { kind: "error" }
  | { kind: "close"; code: number; reason: string };
export type BrowserSocketFactory = (
  sameOriginUrl: string,
  receive: (event: SocketEvent) => void,
) => { send(data: string | Uint8Array): void; close(code: number, reason?: string): void };
const utf8 = new TextEncoder();
export const browserSocketFactory: BrowserSocketFactory = (url, receive) => {
  const socket = new WebSocket(url, "kraka.flow.v1");
  let flow: ControlStream | undefined;
  let configured = false;
  const codec = {
    encode: (text: string) => utf8.encode(text),
    decode: (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b),
  };
  socket.binaryType = "arraybuffer";
  socket.onopen = () => receive({ kind: "open" });
  socket.onmessage = (e) => {
    try {
      const wire = typeof e.data === "string" ? e.data : new Uint8Array(e.data);
      if (!flow) {
        const first = decodeFrame(wire, codec);
        if (
          first.lane !== "control" ||
          first.message.kind !== "server.hello" ||
          first.epoch !== first.message.connectionId
        )
          throw Error("Missing framed hello");
        flow = new ControlStream(
          first.epoch,
          {
            utf8: codec,
            now: () => performance.now(),
            write(bytes) {
              socket.send(typeof bytes === "string" ? bytes : new Uint8Array(bytes));
              return 1;
            },
          },
          () => configured,
          (message) => {
            receive({ kind: "message", data: JSON.stringify(message) });
            if (message.kind === "session.configuration") configured = true;
          },
        );
      }
      flow.input(wire);
    } catch {
      receive({ kind: "error" });
    }
  };
  socket.onclose = (e) => {
    flow?.close();
    receive({ kind: "close", code: e.code, reason: e.reason });
  };
  socket.onerror = () => receive({ kind: "error" });
  return {
    send(data) {
      if (!flow || typeof data !== "string") throw Error("No browser control stream");
      flow.send(v.parse(ControlMessageSchema, JSON.parse(data)));
    },
    close(code, reason) {
      flow?.close();
      socket.close(code === 1000 || code >= 3000 ? code : 4000, reason);
    },
  };
};
