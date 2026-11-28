import { createServer } from "node:https";
import { readFile } from "node:fs/promises";
import { once } from "node:events";
import { WebSocketServer, WebSocket } from "ws";
import { Journal } from "./route-network";

export const handoffOrigin = "https://kraka.test:8443";
export async function handoffRoute(
  upstream: string,
  options = {
    host: "10.78.41.10",
    port: 8443,
    origin: handoffOrigin,
    cert: "/fixture/leaf.pem",
    key: "/fixture/leaf.key",
  },
) {
  const base = new URL(upstream);
  const protocol = new URL(base.origin);
  protocol.protocol = "ws:";
  const server = createServer(
    { cert: await readFile(options.cert), key: await readFile(options.key) },
    async (req, res) => {
      if (req.method !== "GET" || !["/", "/assets/browser-host.js"].includes(req.url ?? "")) {
        res.writeHead(404);
        res.end();
        return;
      }
      try {
        const response = await fetch(new URL(req.url ?? "/", base));
        res.writeHead(response.status, {
          "Content-Type": response.headers.get("content-type") ?? "text/plain",
        });
        res.end(await response.text());
      } catch {
        res.writeHead(502);
        res.end();
      }
    },
  );
  const sockets = new WebSocketServer({ noServer: true });
  const inputs = new Journal<{
    kind: "sent" | "dropped" | "receipt";
    commandId: string;
    epoch: string;
    messageId?: string;
  }>();
  let dropped = false;
  server.on("upgrade", (req, stream, head) => {
    const requested = req.headers["sec-websocket-protocol"];
    if (
      req.headers.origin !== options.origin ||
      !req.url?.startsWith("/ws?nonce=") ||
      (requested !== "kraka.flow.v1" && requested !== "kraka.thread.v1")
    ) {
      stream.destroy();
      return;
    }
    const dest = new WebSocket(protocol.origin + req.url, requested, { origin: options.origin });
    stream.on("error", () => dest.terminate());
    dest.on("error", () => stream.destroy());
    dest.once("open", () =>
      sockets.handleUpgrade(req, stream, head, (ws) => {
        const commands = new Set<string>();
        ws.on("error", () => dest.terminate());
        ws.on("close", () => dest.terminate());
        dest.on("close", () => ws.terminate());
        ws.on("message", (wire, binary) => {
          if (!binary) {
            const frame = JSON.parse(wire.toString()),
              m = frame.message;
            if (m?.method === "input.send") {
              commands.add(m.commandId);
              inputs.push({ kind: "sent", epoch: frame.epoch, commandId: m.commandId });
            }
          }
          if (dest.readyState === WebSocket.OPEN) dest.send(wire, { binary });
        });
        dest.on("message", (wire, binary) => {
          if (!binary) {
            const frame = JSON.parse(wire.toString()),
              m = frame.message;
            if (
              m?.kind === "accepted" &&
              m.result?.kind === "inputScheduled" &&
              commands.has(m.commandId)
            ) {
              inputs.push({
                kind: dropped ? "receipt" : "dropped",
                commandId: m.commandId,
                epoch: frame.epoch,
                messageId: m.result.messageId,
              });
              if (!dropped) {
                dropped = true;
                ws.terminate();
                dest.terminate();
                return;
              }
            }
          }
          if (ws.readyState === WebSocket.OPEN) ws.send(wire, { binary });
        });
      }),
    );
  });
  server.listen(options.port, options.host);
  await once(server, "listening");
  return {
    inputs,
    async close() {
      for (const ws of sockets.clients) ws.terminate();
      sockets.close();
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    },
  };
}
