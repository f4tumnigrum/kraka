import { afterAll, expect, test } from "bun:test";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandIdSchema,
  ThreadIdSchema,
  type EnvironmentIdentity,
  type Route,
  type RouteId,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import { selectRoute, type RouteEvent, type RouteSelector } from "../packages/client-runtime/src";
import { DeviceRouteDirectory, dialRoute, routeClock } from "../packages/cli-client/src";
import { validateNamed } from "./reference-client";
import { withState, within } from "./fixtures/replay-process";
import {
  Journal,
  closedOrigin,
  deviceHost,
  directoryPath,
  pathTo,
  route,
  startPeer,
} from "./fixtures/route-network";

const completed = new Set<string>();
afterAll(() => {
  if (process.env.KRAKA_REQUIRED_ROUTE_CASES === "1")
    expect([...completed].sort()).toEqual(["S-CLIENT-018", "S-CONN-001", "S-CONN-003/027"]);
});

const schema = await Bun.file("docs/generated/protocol/protocol.schema.json").json();
async function network(dir: string) {
  const cleanup: Array<() => unknown> = [];
  const device = await deviceHost();
  return {
    device,
    async peer(id: string, state = "usable") {
      const peer = await startPeer(dir, id, device.publicKey, state);
      cleanup.unshift(peer.stop);
      return peer;
    },
    path(origin: string) {
      const path = pathTo(origin);
      cleanup.unshift(path.stop);
      return path;
    },
    catalog(pin: EnvironmentIdentity, routes: Route[], name: string) {
      const store = new DeviceRouteDirectory(directoryPath(dir, name));
      cleanup.unshift(() => store.close());
      const ready = store.load(() => ({
        formatVersion: 1,
        environments: [
          { environmentId: pin.id, pinnedIdentity: pin, preferredRouteId: routes[0]?.id, routes },
        ],
      }));
      if (ready.kind !== "ready") throw Error("Invalid fixture catalog");
      return store;
    },
    connect(pin: EnvironmentIdentity, rows: Route[], name: string) {
      const store = this.catalog(pin, rows, name);
      const events = new Journal<RouteEvent>();
      const result = store.connect(pin.id, device.credentials(pin), (e) => events.push(e));
      if (result.kind !== "selecting") throw Error("Expected pinned routes");
      cleanup.unshift(result.selector.close);
      return { events, client: result.selector, store };
    },
    own(client: RouteSelector) {
      cleanup.unshift(client.close);
    },
    async close() {
      const errors = [];
      for (const stop of cleanup)
        try {
          await stop();
        } catch (e) {
          errors.push(e);
        }
      if (errors.length) throw new AggregateError(errors, "Fixture teardown");
    },
  };
}
const unavailable = (routeId: RouteId) => (e: RouteEvent) =>
  e.kind === "route" && e.routeId === routeId && e.status.kind === "unavailable";
const read = (command: string) => ({
  commandId: v.parse(CommandIdSchema, command),
  method: "thread.readHistory" as const,
  payload: { threadId: v.parse(ThreadIdSchema, "T"), anchor: null, streamId: 1 },
});
const receipt = (command: string) => (e: RouteEvent) =>
  e.kind === "receipt" && e.receipt.commandId === command && e.receipt.kind === "accepted";
const proofs = (path: ReturnType<typeof pathTo>) => path.records.reduce((n, r) => n + r.auth, 0);

test(
  "S-CONN-001 restores E and reads the same thread through the configured replacement",
  () =>
    withState(async (dir) => {
      const n = await network(dir);
      try {
        const e = await n.peer("E");
        const first = n.path(e.origin);
        const backup = n.path(e.origin);
        backup.hold("server.hello");
        const silent = route(e.identity, "backup", backup.origin);
        const working = route(e.identity, "first", first.origin);
        const refused = route(e.identity, "refused", closedOrigin());
        const { events, client, store } = n.connect(
          e.identity,
          [silent, working, refused],
          "switch",
        );
        const catalog = store.load();
        const initial = await events.until((e) => e.kind === "sender");
        expect(initial).toMatchObject({
          routeId: working.id,
          hello: { identity: e.identity },
          configuration: { environment: { id: "E" } },
        });
        expect(await client.send(read("open-T"))).toBe(true);
        await events.until(receipt("open-T"));
        await events.until(unavailable(refused.id));
        await events.until(unavailable(silent.id));
        expect(client.status(refused.id)).toMatchObject({ reason: "connectionRefused" });
        expect(client.status(silent.id)).toMatchObject({ reason: "noResponse" });
        first.hold("server.hello");
        first.cut();
        await events.until((e) => e.kind === "disconnected");
        expect(client.active).toBeNull();
        backup.release();
        backup.hold("session.configuration");
        client.retry();
        await backup.frames.until((e) => e.kind === "session.configuration");
        expect(await client.send(read("too-early"))).toBe(false);
        backup.release();
        const installed = await events.until((e) => e.kind === "sender" && e.routeId === silent.id);
        expect(installed).toMatchObject({
          hello: { identity: e.identity },
          configuration: { environment: { id: "E" } },
        });
        if (installed.kind !== "sender") throw Error("Missing configuration");
        expect(validateNamed(schema, "ServerHello", installed.hello)).toBe(true);
        expect(validateNamed(schema, "SessionConfiguration", installed.configuration)).toBe(true);
        first.release();
        expect(await client.send(read("next-T"))).toBe(true);
        await events.until(receipt("next-T"));
        expect(first.records.flatMap((r) => r.commands)).toEqual(["open-T"]);
        expect(backup.records.flatMap((r) => r.commands)).toEqual(["next-T"]);
        expect(proofs(first)).toBe(1);
        expect(proofs(backup)).toBe(1);
        const nonces = [...first.records, ...backup.records].map((r) => r.nonce);
        expect(nonces.every((value) => /^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
        expect(new Set(nonces).size).toBe(nonces.length);
        expect(store.load()).toEqual(catalog);
        completed.add("S-CONN-001");
      } finally {
        await n.close();
      }
    }),
  25000,
);

test(
  "S-CONN-003 / S-CONN-027 distinguishes verified F, a changed key, and silence",
  () =>
    withState(async (dir) => {
      const n = await network(dir);
      try {
        const e = await n.peer("E");
        const f = await n.peer("F");
        const old = n.path(e.origin);
        const original = route(e.identity, "old", old.origin);
        const { events, client } = n.connect(e.identity, [original], "wrong-id");
        await events.until((e) => e.kind === "sender");
        const signed = n.device.calls.length;
        old.point(f.origin);
        old.cut();
        await events.until((e) => e.kind === "disconnected");
        client.retry();
        await events.until(
          (e) =>
            unavailable(original.id)(e) &&
            e.kind === "route" &&
            e.status.kind === "unavailable" &&
            typeof e.status.reason === "object",
        );
        expect(client.status(original.id)).toMatchObject({
          reason: { kind: "wrongEnvironment", actualEnvironmentId: "F" },
        });
        expect(old.records.slice(1)).toHaveLength(1);
        expect(old.records[1]).toMatchObject({
          auth: 0,
          incoming: [{ kind: "server.hello", identity: f.identity }],
        });
        const otherKey = await n.peer("E");
        const changed = n.path(otherKey.origin);
        const wrongKey = route(e.identity, "changed-key", changed.origin);
        const mismatch = n.connect(e.identity, [wrongKey], "wrong-key");
        const diagnosis = await mismatch.events.until((e) => e.kind === "diagnostic");
        expect(diagnosis).toMatchObject({
          diagnostic: { detail: { stage: "environmentIdentity", reason: "pinnedKeyMismatch" } },
        });
        const silent = n.path(f.origin);
        silent.hold("server.hello");
        const silentRoute = route(e.identity, "silent", silent.origin);
        const noReply = n.connect(e.identity, [silentRoute], "no-reply");
        await noReply.events.until(unavailable(silentRoute.id));
        expect(noReply.client.status(silentRoute.id)).toMatchObject({ reason: "noResponse" });
        noReply.client.close();
        silent.release();
        await Bun.sleep(0);
        expect(n.device.calls.length).toBe(signed);
        expect(old.records.slice(1).map((r) => r.auth)).toEqual([0]);
        expect(proofs(changed) + proofs(silent)).toBe(0);
        const expiredPeer = await n.peer("registered", "expired");
        const expired = n.path(expiredPeer.origin);
        const registered = route(expiredPeer.identity, "expired", expired.origin);
        const rejected = n.connect(expiredPeer.identity, [registered], "expired-device");
        await rejected.events.until(unavailable(registered.id));
        expect(rejected.client.status(registered.id)).toMatchObject({
          reason: { kind: "authenticationRejected", reason: "keyExpired" },
        });
        const refusal = await expired.frames.until((f) => f.kind === "session.rejected");
        expect(validateNamed(schema, "SessionRejected", refusal.frame)).toBe(true);
        expect(rejected.client.hostStatus().kind).toBe("unknown");
        completed.add("S-CONN-003/027");
      } finally {
        await n.close();
      }
    }),
  25000,
);

test(
  "S-CLIENT-018 all routes expire and an older signed hello cannot recover a sender",
  () =>
    withState(async (dir) => {
      const n = await network(dir);
      try {
        const e = await n.peer("E");
        const p = n.path(e.origin);
        const q = n.path(e.origin);
        const rows = [route(e.identity, "old", p.origin), route(e.identity, "backup", q.origin)];
        const catalog = n.catalog(e.identity, rows, "all-down").load();
        if (catalog.kind !== "ready" || !catalog.catalog.environments[0]?.pinnedIdentity)
          throw Error("Missing cached pin");
        const entry = catalog.catalog.environments[0];
        const cache = join(dir, "cached-thread.json");
        await Bun.write(cache, JSON.stringify({ environmentId: "E", threadId: "T" }));
        const events = new Journal<RouteEvent>();
        const delayed: Array<() => void> = [];
        const received = Promise.withResolvers<void>();
        const client = selectRoute({
          expectedIdentity: e.identity,
          orderedRoutes: entry.routes,
          activeEpoch: 7,
          clock: routeClock,
          random: { bytes: (n) => crypto.getRandomValues(new Uint8Array(n)) },
          credentials: n.device.credentials(e.identity),
          verify: verifyP256,
          observe: (e) => events.push(e),
          dial: (url, deliver) =>
            dialRoute(url, (event) => {
              if (event.kind === "frame") {
                delayed.push(() => deliver(event));
                received.resolve();
              } else deliver(event);
            }),
        });
        n.own(client);
        await within(received.promise, 5000, "Old hello queued by the host");
        client.retry();
        await Promise.all(rows.map((r) => events.until(unavailable(r.id))));
        for (const r of rows)
          expect(client.status(r.id)).toMatchObject({ kind: "unavailable", reason: "noResponse" });
        expect(delayed.length).toBeGreaterThanOrEqual(3);
        for (const deliver of delayed.splice(0)) deliver();
        await Bun.sleep(0);
        expect(client.active).toBeNull();
        expect(await client.send(read("offline"))).toBe(false);
        expect(client.hostStatus()).toEqual({ kind: "unknown", lastObservedAt: null });
        expect(await Bun.file(cache).json()).toEqual({ environmentId: "E", threadId: "T" });
        expect(events.items.some((e) => e.kind === "sender")).toBe(false);
        expect(proofs(p) + proofs(q)).toBe(0);
        expect(n.device.calls).toHaveLength(0);
        completed.add("S-CLIENT-018");
      } finally {
        await n.close();
      }
    }),
  18000,
);
