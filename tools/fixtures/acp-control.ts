import * as v from "valibot";
import { Journal } from "./route-network";
const entry = v.object({
  peer: v.string(),
  sessionId: v.string(),
  kind: v.string(),
  key: v.union([v.string(), v.number()]),
  wire: v.optional(v.unknown()),
});
export function acpControl() {
  const ledger = new Journal<v.InferOutput<typeof entry>>();
  const releases = new Map<string | number, ReturnType<typeof Promise.withResolvers<void>>>();
  let draining = false;
  function latch(key: string | number) {
    const existing = releases.get(key);
    if (existing) return existing;
    const pending = Promise.withResolvers<void>();
    releases.set(key, pending);
    return pending;
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const item = v.parse(entry, await request.json());
      ledger.push(item);
      if (item.kind === "terminalHeld" && !draining) await latch(item.key).promise;
      return new Response("ok");
    },
  });
  return {
    ledger,
    url: server.url.href,
    waitFor: (kind: string, key: string | number) =>
      ledger.untilDispatch((e) => e.kind === kind && e.key === key),
    count: (kind: string, key: string | number, peer?: string) =>
      ledger.items.filter((e) => e.kind === kind && e.key === key && (!peer || e.peer === peer))
        .length,
    release: (key: string | number) => latch(key).resolve(),
    drain() {
      draining = true;
      for (const p of releases.values()) p.resolve();
    },
    async close() {
      await server.stop(true);
    },
  };
}
