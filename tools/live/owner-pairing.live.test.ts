// Live cases 4; required groups []
import { afterAll, expect, onTestFinished, test } from "bun:test";
import { connect } from "node:net";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import * as v from "valibot";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  SessionRejectedSchema,
  ServerHelloSchema,
  SubscriptionIdSchema,
  PairingRequestIdSchema,
  canonicalJson,
  ThreadIdSchema,
  type PermissionGrant,
  type AuthorizationTarget,
  type PermissionItem,
  type AccessChangeSchema,
} from "@kraka/protocol";
import { verifyP256 } from "@kraka/protocol/web-crypto";
import {
  pairingDisplay,
  pairingConnection,
  openDeviceCredentials,
} from "../../packages/cli-client/src";
import { withState, within } from "../fixtures/replay-process";
import {
  startPairedProject,
  commandId,
  invite,
  pendingFor,
  approve,
  beginApplication,
  type Client,
} from "../fixtures/paired-project";
export { startPairedProject } from "../fixtures/paired-project";
function testProject(stateDir: string, requests: PermissionItem[][] = []) {
  const lifetime = new AbortController();
  onTestFinished(() => lifetime.abort());
  return startPairedProject({ stateDir, projectId: "P", requests, signal: lifetime.signal });
}

const completed = new Set<string>();
afterAll(() => {
  if (process.env.KRAKA_REQUIRED_PAIRING_CASES === "1")
    expect([...completed].sort()).toEqual(["admission", "pair", "revoke", "upgrade"]);
});
async function grants(client: Client, target: AuthorizationTarget) {
  let after: string | null = null;
  const rows: PermissionGrant[] = [];
  do {
    const r = await client.request({
      method: "access.listGrants",
      payload: { target, after },
      commandId: commandId(),
    });
    if (r.kind !== "accepted" || r.result.kind !== "grantsListed") throw Error("Grant page denied");
    rows.push(...r.result.grants);
    after = r.result.next;
  } while (after);
  return rows;
}
async function changes(client: Client, target: AuthorizationTarget) {
  let after: string | null = null;
  const rows: v.InferOutput<typeof AccessChangeSchema>[] = [];
  do {
    const r = await client.request({
      method: "access.listChanges",
      payload: { target, after },
      commandId: commandId(),
    });
    if (r.kind !== "accepted" || r.result.kind !== "accessChangesListed")
      throw Error("Change page denied");
    rows.push(...r.result.changes);
    after = r.result.next;
  } while (after);
  return rows;
}
async function status(origin: string, target: string, origins: string[]) {
  return within(
    new Promise<number>((resolve, reject) => {
      const socket = connect(Number(new URL(origin).port), "127.0.0.1", () =>
        socket.write(
          [
            `GET ${target} HTTP/1.1`,
            "Host: localhost",
            "Upgrade: websocket",
            "Connection: Upgrade",
            "Sec-WebSocket-Version: 13",
            `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
            ...origins.map((o) => `Origin: ${o}`),
            "",
            "",
          ].join("\r\n"),
        ),
      );
      socket.once("data", (chunk) => {
        resolve(Number(chunk.toString().split(" ")[1]));
        socket.destroy();
      });
      socket.once("error", reject);
      socket.setTimeout(2000, () => socket.destroy(Error("HTTP upgrade timed out")));
    }),
    3000,
    "Upgrade status",
  );
}
test(
  "Admission checks the raw upgrade and releases only the signed hello",
  () =>
    withState(async (stateDir) => {
      const f = await testProject(stateDir);
      try {
        const target = `/ws?nonce=${randomBytes(32).toString("base64url")}`;
        for (const [path, origins, want] of [
          [target, ["null"], 403],
          [target, ["https://unlisted.test"], 403],
          [target, ["https://example.test", "https://example.test"], 403],
          ["/ws?nonce=short", ["null"], 400],
          [`${target}&nonce=x`, ["null"], 400],
          ["/wrong", ["null"], 404],
          [`/x/..${target}`, [], 404],
        ] as const)
          expect(await status(f.host.origin, path, [...origins])).toBe(want);
        for (const header of [null, "https://EXAMPLE.test:443", f.host.origin]) {
          const nonce = randomBytes(32).toString("base64url"),
            url = `${f.host.origin.replace("http:", "ws:")}/ws?nonce=${nonce}`;
          const ws = new WebSocket(url, header === null ? {} : { headers: { Origin: header } });
          const frames: unknown[] = [];
          const barrier = Promise.withResolvers<void>();
          const fresh = v.parse(PairingRequestIdSchema, crypto.randomUUID());
          ws.onmessage = (e) => {
            frames.push(JSON.parse(String(e.data)));
            if (frames.length === 1)
              ws.send(
                JSON.stringify({
                  kind: "pairing.request",
                  environmentId: f.identity.id,
                  inviteId: "absent",
                  requestId: fresh,
                  deviceId: f.owner.device.deviceId,
                  publicKey: f.owner.device.publicKey,
                  target: { kind: "project", projectId: f.projectId },
                }),
              );
            else barrier.resolve();
          };
          try {
            await within(barrier.promise, 3000, "Hello before application");
            const { identityProof, ...hello } = v.parse(ServerHelloSchema, frames[0]);
            expect(hello.clientNonce).toBe(nonce);
            expect(hello.identity).toEqual(f.identity);
            expect(
              await verifyP256(f.identity.publicKey, canonicalJson(hello), identityProof),
            ).toBe(true);
            expect(frames.slice(1)).toEqual([
              { kind: "pairing.rejected", requestId: fresh, reason: "invalidProof" },
            ]);
            expect(await status(f.host.origin, `/ws?nonce=${nonce}`, [])).toBe(400);
          } finally {
            ws.close();
          }
        }
        completed.add("admission");
      } finally {
        await f.close();
      }
    }),
  20000,
);
test(
  "Pair, race and recover the selected application across daemon restart",
  () =>
    withState(async (stateDir) => {
      const f = await testProject(stateDir);
      const open: Array<() => void> = [];
      try {
        const id = await invite(f.owner, f.projectId),
          permissions = [...DEFAULT_DEVICE_PERMISSIONS];
        const winner = await f.local("applicant"),
          other = await f.local("other");
        const target = { kind: "project" as const, projectId: f.projectId };
        const start = async (
          d: typeof winner,
          inv = id,
          rights: PermissionItem[] = permissions,
        ) => {
          const a = await beginApplication(d, f.host.origin, f.identity, f.projectId, inv, rights);
          open.push(a.socket.close);
          return a;
        };
        const a = await start(winner),
          b = await start(other);
        const listed = await pendingFor(f.owner, f.projectId, id);
        if (!listed[0]) throw Error("Missing application on owner display");
        expect(pairingDisplay(listed[0])).toEqual(pairingDisplay(a.pending));
        expect(a.pending.confirmationCode).toMatch(/^\d{6}$/);
        expect(b.pending.confirmationCode).not.toBe(a.pending.confirmationCode);
        expect(listed.map((p) => p.permissions)).toEqual([permissions, permissions]);
        const pendingAuth = await pairingConnection(f.host.origin, f.identity);
        open.push(pendingAuth.close);
        const auth = async (d: typeof winner, s: typeof pendingAuth) => {
          const { connectionId, challenge, challengeId, clientNonce, protocolVersion, features } =
            s.hello;
          const fields = {
            kind: "client.authenticate",
            method: "session.authenticate",
            environmentId: f.identity.id,
            connectionId,
            challenge,
            challengeId,
            clientNonce,
            features,
            protocolVersion,
            sequence: 1,
            signer: { kind: "device", deviceId: d.deviceId, keyId: d.keyId },
          };
          s.send({ ...fields, signature: await d.sign(canonicalJson(fields)) });
          return s.next(SessionRejectedSchema);
        };
        expect((await auth(winner, pendingAuth)).reason).toBe("unknownKey");
        await approve(f.owner, a.pending);
        const [x, y] = await Promise.all([a.proof(), b.proof()]);
        await f.host.control("lose");
        a.socket.send(x);
        b.socket.send(y);
        const losing = await b.socket.result();
        expect(losing.kind).toBe("pairing.rejected");
        if (losing.kind === "pairing.rejected")
          expect(["notSelected", "alreadyExchanged"]).toContain(losing.reason);
        await f.host.event("lostReply");
        await f.restart();
        const reopened = await openDeviceCredentials(
          join(f.stateDir, "applicant", "device.sqlite"),
        );
        open.push(reopened.close);
        const retry = await start(reopened);
        const fresh = await retry.proof();
        expect(fresh.challengeId).not.toBe(x.challengeId);
        expect(fresh.claimId).toBe(x.claimId);
        retry.socket.send(x);
        expect(await retry.socket.result()).toMatchObject({ reason: "invalidProof" });
        const valid = await start(reopened);
        valid.socket.send(await valid.proof());
        const receipt = await valid.socket.result();
        const reg = valid.finish(receipt);
        expect(reg.permissions).toEqual(permissions);
        const paired = await f.attach(reopened, reg.principal);
        expect(paired.configuration.environment.id).toBe(f.identity.id);
        const gs = await grants(f.owner, target);
        expect(gs.map((g) => g.permission)).toEqual(permissions);
        expect(new Set(gs.map((g) => g.principalId))).toEqual(new Set([reg.principal.id]));
        expect(gs.every((g) => g.inheritance === "children")).toBe(true);
        expect((await changes(f.owner, target)).map((c) => c.change.kind)).toEqual(
          permissions.map(() => "granted"),
        );
        const cancelId = await invite(f.owner, f.projectId);
        const cancel = await start(await f.local("cancel"), cancelId);
        await approve(f.owner, cancel.pending);
        const proof = await cancel.proof();
        expect(
          await f.owner.request({
            method: "device.pairing.cancel",
            commandId: commandId(),
            payload: { inviteId: cancelId },
          }),
        ).toMatchObject({ kind: "accepted", result: { kind: "inviteCancelled" } });
        cancel.socket.send(proof);
        expect(await cancel.socket.result()).toMatchObject({
          kind: "pairing.rejected",
          reason: "cancelled",
        });
        expect(await grants(f.owner, target)).toEqual(gs);
        await f.host.control("advance", { ms: 2_592_000_000 });
        const expired = await pairingConnection(f.host.origin, f.identity);
        open.push(expired.close);
        await expired.apply(a.record);
        const c = await expired.challenge();
        const fields = {
          ...x,
          claimId: c.claimId,
          challengeId: c.challengeId,
          challenge: c.challenge,
        };
        const { signature: _old, ...unsigned } = fields;
        expired.send({ ...unsigned, signature: await winner.sign(canonicalJson(unsigned)) });
        expect(await expired.result()).toMatchObject({
          kind: "pairing.rejected",
          reason: "expired",
        });
        const expiredAuth = await pairingConnection(f.host.origin, f.identity);
        open.push(expiredAuth.close);
        expect((await auth(winner, expiredAuth)).reason).toBe("keyExpired");
        completed.add("pair");
      } finally {
        for (const close of open.reverse()) close();
        await f.close();
      }
    }),
  25000,
);
test(
  "Revoke closes the connected subscriber while the owner and executor continue",
  () =>
    withState(async (stateDir) => {
      const f = await testProject(stateDir, [["thread.view"]]);
      try {
        const target = f.clients[0];
        if (!target) throw Error("Missing subscriber");
        await f.host.control("executor");
        await f.host.event("executorActive");
        const executorThread = v.parse(
          ThreadIdSchema,
          (await f.host.event("executorThread")).threadId,
        );
        const open = {
          method: "subscription.openThread" as const,
          commandId: commandId(),
          payload: {
            subscriptionId: v.parse(SubscriptionIdSchema, crypto.randomUUID()),
            streamId: 1,
            threadId: executorThread,
            after: null,
            knownWindow: [],
            recheckTodos: [],
          },
        };
        expect(await target.request(open)).toMatchObject({
          kind: "accepted",
          result: { kind: "subscriptionOpened" },
        });
        await f.host.control("publish", open.payload);
        await target.events.until(
          (e) =>
            e.kind === "control" &&
            e.frame.kind === "subscription.reset" &&
            e.frame.subscriptionId === open.payload.subscriptionId,
        );
        const alternateOpen = {
          ...open,
          commandId: commandId(),
          payload: {
            ...open.payload,
            streamId: 2,
            threadId: f.threadId,
            subscriptionId: v.parse(SubscriptionIdSchema, crypto.randomUUID()),
          },
        };
        expect((await target.request(alternateOpen)).kind).toBe("accepted");
        const projectGrants = await grants(f.owner, { kind: "project", projectId: f.projectId });
        const inherited = projectGrants.find(
          (g) => g.principalId === target.principal.id && g.permission === "thread.view",
        );
        if (!inherited) throw Error("Missing inherited stream access");
        expect(
          (
            await f.owner.request({
              method: "access.grant",
              commandId: commandId(),
              payload: {
                principalId: target.principal.id,
                target: { kind: "thread", threadId: executorThread },
                permission: "thread.view",
                modeCeiling: "ask",
                inheritance: "targetOnly",
              },
            })
          ).kind,
        ).toBe("accepted");
        expect(
          (
            await f.owner.request({
              method: "access.revoke",
              commandId: commandId(),
              payload: { grantId: inherited.id },
            })
          ).kind,
        ).toBe("accepted");
        await target.events.until(
          (e) =>
            e.kind === "control" &&
            e.frame.kind === "subscription.ended" &&
            e.frame.subscriptionId === alternateOpen.payload.subscriptionId &&
            e.frame.reason === "authorizationRevoked",
        );
        const since = target.events.items.length;
        await f.host.control("publish", open.payload);
        await target.events.until(
          (e) =>
            e.kind === "control" &&
            e.frame.kind === "subscription.reset" &&
            e.frame.subscriptionId === open.payload.subscriptionId,
          since,
        );
        const command = {
          method: "device.revoke" as const,
          commandId: commandId(),
          payload: { deviceId: target.device.deviceId, deviceKeyId: target.device.keyId },
        };
        const start = performance.now();
        const receipt = await f.owner.request(command);
        expect(receipt.kind).toBe("accepted");
        await f.host.events.until(
          (e) => e.kind === "revoked" && e.deviceId === target.device.deviceId,
        );
        await target.traffic.until((e) => e.kind === "closed" && e.code === 4001);
        expect(performance.now() - start).toBeLessThan(1000);
        const ws = await pairingConnection(f.host.origin, f.identity);
        try {
          const { protocolVersion, features, connectionId, challengeId, challenge, clientNonce } =
            ws.hello;
          const fields = {
            kind: "client.authenticate",
            method: "session.authenticate",
            environmentId: f.identity.id,
            protocolVersion,
            features,
            connectionId,
            challengeId,
            challenge,
            clientNonce,
            sequence: 1,
            signer: {
              kind: "device",
              keyId: target.device.keyId,
              deviceId: target.device.deviceId,
            },
          };
          ws.send({ ...fields, signature: await target.device.sign(canonicalJson(fields)) });
          expect(await ws.next(SessionRejectedSchema)).toEqual({
            kind: "session.rejected",
            reason: "revokedKey",
          });
        } finally {
          ws.close();
        }
        expect(await f.owner.request(command)).toEqual(receipt);
        const r = await f.owner.request({
          method: "access.listSessions",
          commandId: commandId(),
          payload: {},
        });
        expect(r).toMatchObject({
          kind: "accepted",
          result: { kind: "sessionsListed", sessions: [{ principal: f.owner.principal }] },
        });
        const boundary = f.host.events.items.findIndex((e) => e.kind === "revoked");
        expect(
          f.host.events.items
            .slice(boundary + 1)
            .filter((e) => e.kind === "accepted" && e.deviceId === target.device.deviceId),
        ).toHaveLength(0);
        await f.host.control("finish");
        expect(
          f.host.events.items.some(
            (e) =>
              e.event === "executorUpdate" &&
              JSON.stringify(e.message).includes('"kind":"round.ended"'),
          ),
        ).toBe(true);
        completed.add("revoke");
      } finally {
        await f.close();
      }
    }),
  20000,
);
test(
  "First-owner upgrade needs a separate local decision and returns one durable grant",
  () =>
    withState(async (stateDir) => {
      const f = await testProject(stateDir, [[...DEFAULT_DEVICE_PERMISSIONS]]);
      try {
        const target = { kind: "environment" as const, environmentId: f.identity.id },
          d = f.owner.device;
        expect((await grants(f.owner, target)).map((g) => g.permission)).toEqual([
          ...DEFAULT_DEVICE_PERMISSIONS,
        ]);
        const input = { deviceId: d.deviceId, keyId: d.keyId, commandId: commandId() };
        await f.host.control("presence", { allowed: false });
        expect(await f.host.control("upgrade", input)).toBeNull();
        expect(
          (await grants(f.owner, target)).some((g) => g.permission === "environment.upgrade"),
        ).toBe(false);
        await f.host.control("presence", { allowed: true });
        const id = await f.host.control("upgrade", input);
        expect(typeof id).toBe("string");
        expect(await f.host.control("upgrade", input)).toBe(id);
        expect(
          (await grants(f.owner, target)).filter((g) => g.permission === "environment.upgrade"),
        ).toMatchObject([
          {
            id,
            inheritance: "targetOnly",
            grantedBy: { principalId: f.owner.principal.id },
            target,
          },
        ]);
        expect(
          (await changes(f.owner, target)).filter((c) => c.commandId === input.commandId),
        ).toHaveLength(1);
        const paired = f.clients[0];
        if (!paired) throw Error("Missing paired device");
        expect(
          (await grants(paired, { kind: "project", projectId: f.projectId })).map(
            (g) => g.permission,
          ),
        ).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
        expect(
          await paired.request({
            method: "access.listGrants",
            commandId: commandId(),
            payload: { target, after: null },
          }),
        ).toMatchObject({ kind: "rejected", failure: { kind: "missingPermission" } });
        const child = Bun.spawn(
          [
            process.execPath,
            "packages/daemon/src/index.ts",
            "access",
            "grant-owner-upgrade",
            "--state-dir",
            join(f.stateDir, "host"),
            "--device",
            d.deviceId,
            "--key",
            d.keyId,
            "--command-id",
            commandId(),
          ],
          { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
        );
        expect(await child.exited).toBe(1);
        expect(await new Response(child.stderr).text()).toContain("Owner upgrade grant denied");
        expect(
          f.host.events.items.filter(
            (e) =>
              e.event === "presence" && JSON.stringify(e.detail).includes("environment.upgrade"),
          ),
        ).toHaveLength(3);
        completed.add("upgrade");
      } finally {
        await f.close();
      }
    }),
  20000,
);
