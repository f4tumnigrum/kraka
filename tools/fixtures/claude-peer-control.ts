import * as v from "valibot";
import { Journal } from "./route-network";

const row = v.object({
  kind: v.string(),
  key: v.string(),
  session: v.string(),
  detail: v.unknown(),
});
export function claudePeerControl() {
  const events = new Journal<v.InferOutput<typeof row>>();
  const peers = new Map<string, Bun.ServerWebSocket<null>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, s) {
      if (s.upgrade(req, { data: null })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      data: null as null,
      message(ws, raw) {
        const e = v.parse(row, JSON.parse(String(raw)));
        peers.set(e.session, ws);
        events.push(e);
      },
    },
  });
  return {
    totalInputs: () => events.items.filter((e) => e.kind === "input").length,
    url: "ws://127.0.0.1:" + server.port,
    waitFor(kind: string, session: string, key: string) {
      return events.until((e) => e.kind === kind && e.session === session && e.key === key);
    },
    count(kind: string, session: string, key: string) {
      return events.items.filter((e) => e.kind === kind && e.session === session && e.key === key)
        .length;
    },
    release(session: string, key: string) {
      peers.get(session)?.send(JSON.stringify({ kind: "release", session, key }));
    },
    releaseHeld() {
      for (const e of events.items)
        if (e.kind === "held")
          peers
            .get(e.session)
            ?.send(JSON.stringify({ kind: "release", session: e.session, key: e.key }));
    },
    async close() {
      try {
        await Promise.all(
          [...peers.keys()]
            .filter(Boolean)
            .map((session) => events.until((e) => e.kind === "eof" && e.session === session)),
        );
      } finally {
        await server.stop(true);
      }
    },
  };
}
