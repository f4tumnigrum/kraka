import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  CommandIdSchema,
  EnvironmentIdentitySchema,
  ThreadIdSchema,
  RouteSchema,
  DevicePrincipalSchema,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  TRANSPORT_LIMITS,
} from "@kraka/protocol";
import { selectRoute, type RouteEvent, type SocketEvent } from "../src";
import { retryDelay, type RouteClock } from "../src/route-timers";
import { DeviceRouteDirectory } from "../../cli-client/src/routes";

class Clock implements RouteClock {
  now = 0;
  timers = new Set<{ at: number; call: () => void }>();
  nowMilliseconds() {
    return this.now;
  }
  utcMilliseconds() {
    return this.now + 1000000;
  }
  after(ms: number, call: () => void) {
    const timer = { at: this.now + ms, call };
    this.timers.add(timer);
    return () => {
      this.timers.delete(timer);
    };
  }
  advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      const timer = [...this.timers].sort((a, b) => a.at - b.at)[0];
      if (!timer || timer.at > end) break;
      this.now = timer.at;
      this.timers.delete(timer);
      timer.call();
    }
    this.now = end;
  }
}
const identity = v.parse(EnvironmentIdentitySchema, {
  id: "E",
  publicKey: "A".repeat(87),
  keyVersion: 1,
});
const principal = v.parse(DevicePrincipalSchema, {
  kind: "device",
  id: "principal",
  ownerId: "owner",
  deviceId: "device",
});
const signer = {
  kind: "device" as const,
  deviceId: v.parse(DeviceIdSchema, "device"),
  keyId: v.parse(DeviceKeyIdSchema, "key"),
};
const route = (i: number) =>
  v.parse(RouteSchema, {
    id: `r${i}`,
    environmentId: "E",
    kind: "lan",
    endpoint: `https://r${i}.test`,
    status: { kind: "untested" },
  });
const tick = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
function fixtures(count = 1) {
  const clock = new Clock();
  const events: RouteEvent[] = [];
  const signed: string[] = [];
  const sockets: Array<{
    nonce: string;
    emit: (event: SocketEvent) => void;
    sent: object[];
    closed: number[];
  }> = [];
  const rows = Array.from({ length: count }, (_, i) => route(i));
  let serial = 0;
  const client = selectRoute({
    expectedIdentity: identity,
    orderedRoutes: rows,
    activeEpoch: 2,
    clock,
    random: { bytes: (length) => new Uint8Array(length).fill(length === 4 ? 0 : ++serial) },
    credentials: {
      identity,
      principal,
      signer,
      async sign(s) {
        signed.push(s);
        return "S".repeat(86);
      },
    },
    verify: async (_key, _text, sig) => sig === "S".repeat(86),
    observe: (e) => events.push(e),
    dial(url, emit) {
      const nonce = new URL(url).searchParams.get("nonce");
      if (!nonce) throw Error("Missing nonce");
      const sent: object[] = [],
        closed: number[] = [];
      sockets.push({ nonce, emit, sent, closed });
      return {
        send: (f) => {
          sent.push(f);
        },
        close: (c) => {
          closed.push(c);
        },
      };
    },
  });
  const socket = (i: number) => {
    const s = sockets[i];
    if (!s) throw Error(`Missing socket ${i}`);
    return s;
  };
  const frame = (i: number, value: unknown) => socket(i).emit({ kind: "frame", value });
  const hello = (i: number, extra = {}) =>
    frame(i, {
      kind: "server.hello",
      identity,
      identityProof: "S".repeat(86),
      connectionId: `c${i}`,
      challengeId: `q${i}`,
      challenge: "Q".repeat(43),
      clientNonce: socket(i).nonce,
      protocolVersion: { major: 1, minor: 0 },
      features: [],
      ...extra,
    });
  const auth = (i: number, extra = {}) =>
    frame(i, {
      kind: "session.authorized",
      environmentId: "E",
      connectionId: `c${i}`,
      environmentSessionId: `s${i}`,
      principal,
      signer,
      authorizedAt: 0,
      protocolVersion: { major: 1, minor: 0 },
      features: [],
      ...extra,
    });
  const config = (i: number, extra = {}) =>
    frame(i, {
      kind: "session.configuration",
      connectionId: `c${i}`,
      environmentSessionId: `s${i}`,
      environment: { id: "E", version: "1" },
      version: "1",
      transportLimits: TRANSPORT_LIMITS,
      executors: [],
      ...extra,
    });
  async function win(i: number) {
    hello(i);
    await tick();
    clock.advance(0);
    await tick();
  }
  return { clock, client, events, signed, rows, sockets, socket, frame, hello, auth, config, win };
}
test("preferred route has 500 ms, four probes share a batch, only the first saved winner signs", async () => {
  const h = fixtures(6);
  h.clock.advance(499);
  expect(h.sockets).toHaveLength(1);
  h.clock.advance(1);
  expect(h.sockets).toHaveLength(4);
  h.hello(3);
  h.hello(1);
  await tick();
  h.clock.advance(0);
  await tick();
  expect(h.signed).toHaveLength(1);
  expect(h.socket(1).sent[0]).toMatchObject({ kind: "client.authenticate" });
  expect(h.socket(3).sent).toEqual([]);
  expect(h.socket(3).closed).toEqual([4000]);
  h.hello(0);
  await tick();
  expect(h.socket(0).closed).toEqual([4000]);
  expect(h.sockets).toHaveLength(4);
  h.client.close();
});
test("explicit refusal releases the next route immediately and silence expires at 2500 ms", () => {
  const h = fixtures(5);
  h.socket(0).emit({ kind: "closed", evidence: "connectionRefused" });
  expect(h.sockets).toHaveLength(5);
  expect(h.client.status(route(0).id)).toMatchObject({ reason: "connectionRefused" });
  h.clock.advance(2499);
  expect(h.client.status(route(1).id)?.kind).toBe("probing");
  h.clock.advance(1);
  expect(h.client.status(route(1).id)).toMatchObject({ reason: "noResponse" });
  h.clock.advance(249);
  expect(h.sockets).toHaveLength(5);
  h.clock.advance(1);
  expect(h.sockets).toHaveLength(6);
  h.client.close();
});
test("each observed trust failure has only its public detail and suppresses automatic retries", async () => {
  for (const detail of [
    { stage: "tlsCertificate", reason: "expired" },
    { stage: "sshHostKey", reason: "keyChanged" },
    { stage: "environmentIdentity", reason: "nonceMismatch" },
    { stage: "environmentIdentity", reason: "invalidSignature" },
    { stage: "environmentIdentity", reason: "keyVersionMismatch" },
    {
      stage: "protocolVersion",
      reason: "unsupportedProtocolVersion",
      localVersion: { major: 1, minor: 0 },
      remoteVersion: { major: 2, minor: 1 },
    },
  ] as const) {
    const h = fixtures();
    if (detail.stage === "tlsCertificate" || detail.stage === "sshHostKey")
      h.socket(0).emit({ kind: "closed", evidence: detail });
    else if (detail.stage === "protocolVersion")
      h.hello(0, { protocolVersion: detail.remoteVersion });
    else if (detail.reason === "invalidSignature") h.hello(0, { identityProof: "X".repeat(86) });
    else if (detail.reason === "nonceMismatch") h.hello(0, { clientNonce: "X".repeat(43) });
    else h.hello(0, { identity: { ...identity, keyVersion: 2 } });
    await tick();
    expect(h.events.filter((e) => e.kind === "diagnostic")).toEqual([
      {
        kind: "diagnostic",
        diagnostic: {
          routeId: route(0).id,
          environmentId: identity.id,
          observedAt: 1000000,
          detail,
        },
      },
    ]);
    h.clock.advance(90000);
    expect(h.sockets).toHaveLength(1);
    expect(h.signed).toHaveLength(0);
    if (detail.stage === "protocolVersion")
      expect(h.client.status(route(0).id)?.kind).toBe("reachable");
    h.client.close();
  }
  const h = fixtures();
  h.socket(0).emit({ kind: "closed" });
  expect(h.client.status(route(0).id)).toMatchObject({ reason: "noResponse" });
  expect(h.events.filter((e) => e.kind === "diagnostic")).toEqual([]);
  h.client.close();
});
test("authorization and configuration have separate deadlines and only matching bindings can install", async () => {
  for (const phase of ["hello", "authorized", "wrong-session", "early-config"]) {
    const h = fixtures();
    await h.win(0);
    h.clock.advance(14999);
    if (phase === "hello") h.clock.advance(1);
    else if (phase === "early-config") {
      h.config(0);
      expect(h.client.active).toBeNull();
      h.auth(0);
      expect(h.client.active?.routeId).toBe(route(0).id);
    } else {
      h.auth(0);
      h.clock.advance(74999);
      expect(h.client.status(route(0).id)?.kind).toBe("reachable");
      if (phase === "wrong-session") h.config(0, { environmentSessionId: "other" });
      else h.clock.advance(1);
    }
    if (phase !== "early-config") {
      expect(h.client.active).toBeNull();
      expect(h.client.status(route(0).id)?.kind).toBe("unavailable");
    }
    h.client.close();
  }
});
test("switch keeps the healthy sender until configuration, old callbacks can resolve only its sent IDs", async () => {
  const h = fixtures();
  await h.win(0);
  h.auth(0);
  h.config(0);
  h.client.setCandidates([route(1), route(0)]);
  expect(h.sockets).toHaveLength(1);
  h.client.retry();
  await h.win(1);
  h.auth(1);
  expect(h.client.active?.routeId).toBe(route(0).id);
  const commandId = v.parse(CommandIdSchema, "old-read");
  expect(
    await h.client.send({
      commandId,
      method: "thread.readHistory",
      payload: { threadId: v.parse(ThreadIdSchema, "T"), anchor: null, streamId: 1 },
    }),
  ).toBe(true);
  h.config(1);
  expect(h.client.active?.routeId).toBe(route(1).id);
  expect(h.socket(0).closed).toEqual([1000]);
  for (const id of ["another", commandId, commandId])
    h.frame(0, { kind: "rejected", commandId: id, failure: { kind: "notFound" } });
  h.frame(0, { kind: "subscription.ended", subscriptionId: "stale", reason: "cancelled" });
  h.config(0);
  expect(h.events.filter((e) => e.kind === "receipt")).toHaveLength(1);
  expect(h.events.filter((e) => e.kind === "control")).toHaveLength(0);
  expect(h.client.active?.epoch).toBe(3);
  h.client.close();
});
test("only current-epoch probe replies extend the 15 s deadline, foreground waits 3 s", async () => {
  for (const foreground of [false, true]) {
    const h = fixtures();
    await h.win(0);
    h.auth(0);
    h.config(0);
    h.clock.advance(5000);
    expect(h.socket(0).sent.at(-1)).toMatchObject({ kind: "transport.probe", serial: 1 });
    h.client.retry();
    await h.win(1);
    h.auth(1);
    h.config(1);
    h.clock.advance(14999);
    h.frame(1, { kind: "transport.echo", serial: 2 });
    h.clock.advance(1);
    expect(h.client.active).not.toBeNull();
    if (foreground) h.client.foreground();
    h.clock.advance(foreground ? 2999 : 14998);
    h.frame(0, { kind: "transport.echo", serial: 1 });
    h.frame(1, { kind: "transport.echo", serial: 99999 });
    expect(h.client.active).not.toBeNull();
    h.clock.advance(1);
    expect(h.client.active).toBeNull();
    expect(h.client.hostStatus().kind).toBe("unknown");
    h.client.close();
  }
  expect([0, 1, 2, 20].map((n) => [retryDelay(n, 0), retryDelay(n, 1 - 2 ** -32)])).toEqual([
    [250, 4250],
    [2000, 4000],
    [4000, 8000],
    [150000, 300000],
  ]);
});
test("SQLite migration rolls back the original bytes and retries. Future or corrupt catalogs keep their bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kraka-directory-"));
  const file = join(dir, "routes.sqlite");
  const store = new DeviceRouteDirectory(file);
  const db = new Database(file);
  try {
    expect(store.load()).toEqual({
      kind: "ready",
      catalog: { formatVersion: 1, environments: [] },
    });
    const doc = JSON.stringify(
      [route(0), { ...route(0), id: "duplicate", endpoint: "HTTPS://R0.TEST:443/" }],
      null,
      2,
    );
    const write = (s: string) => db.query("UPDATE route_catalog SET document=? WHERE id=1").run(s);
    const bytes = () =>
      db.query<{ document: string }, []>("SELECT document FROM route_catalog").get()?.document;
    write(doc);
    db.run(
      "CREATE TRIGGER interrupt BEFORE UPDATE ON route_catalog BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    expect(store.load().kind).toBe("commitFailed");
    expect(bytes()).toBe(doc);
    db.run("DROP TRIGGER interrupt");
    expect(store.load()).toMatchObject({
      kind: "ready",
      catalog: {
        environments: [{ pinnedIdentity: null, preferredRouteId: null, routes: [route(0)] }],
      },
    });
    for (const [original, outcome] of [
      ['{ "formatVersion": 9 }', "unsupportedFormat"],
      ['{"oops":7}', "invalidCatalog"],
      ["not JSON", "invalidCatalog"],
    ] as const) {
      write(original);
      const result = store.connect(
        identity.id,
        {
          identity,
          principal,
          signer,
          async sign() {
            throw Error("Unexpected sign");
          },
        },
        () => {
          throw Error("Unexpected dial");
        },
      );
      expect(result.kind).toBe(outcome);
      expect(bytes()).toBe(original);
    }
  } finally {
    db.close();
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
