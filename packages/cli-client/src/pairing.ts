import { dirname } from "node:path";
import { createHash } from "node:crypto";
import { ownedDirectory } from "./private-directory";
import { open, constants } from "node:fs/promises";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  canonicalJson,
  base64url,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  DeviceRegistrationSchema,
  PairingRequestIdSchema,
  PairingPendingSchema,
  PairingChallengeSchema,
  DevicePairingResultSchema,
  ServerHelloSchema,
  type DeviceRegistration,
  type EnvironmentIdentity,
  type ProjectId,
  type PermissionItem,
  type PairingInviteId,
  type PendingRegistration,
  type PairingPending,
  type PairingChallenge,
  type PairingExchange,
} from "@kraka/protocol";
import { signP256, verifyP256 } from "@kraka/protocol/web-crypto";
import {
  completeLocalPairing,
  sameEnvironmentIdentity,
  type RouteCommand,
} from "@kraka/client-runtime";

export function pairingDisplay(pending: PairingPending) {
  return {
    environment: pending.environmentId,
    target: pending.target,
    code: pending.confirmationCode,
    rights: pending.permissions,
    fingerprint: createHash("sha256")
      .update(Buffer.from(pending.publicKey, "base64url"))
      .digest("hex"),
  };
}
export async function openDeviceCredentials(filename: string) {
  await ownedDirectory(dirname(filename));
  const fd = await open(
    filename,
    constants.O_RDWR | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const state = await fd.stat();
    if (
      !state.isFile() ||
      state.nlink !== 1 ||
      (process.platform !== "win32" &&
        (state.uid !== process.geteuid?.() || (state.mode & 0o077) !== 0))
    )
      throw Error("Expected private device credential file");
  } finally {
    await fd.close();
  }
  const db = new Database(filename, { create: true });
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS local_device(id INTEGER PRIMARY KEY CHECK(id=1),device TEXT,key_id TEXT,public TEXT,secret TEXT);CREATE TABLE IF NOT EXISTS registrations(env TEXT PRIMARY KEY,body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS commands(id TEXT PRIMARY KEY,intent TEXT NOT NULL)",
    );
    const select = db.query<{ device: string; key_id: string; public: string; secret: string }, []>(
      "SELECT * FROM local_device",
    );
    let row = select.get();
    if (!row) {
      const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
        "sign",
        "verify",
      ]);
      const pub = base64url(new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)));
      const secret = Buffer.from(await crypto.subtle.exportKey("pkcs8", keys.privateKey)).toString(
        "base64url",
      );
      db.run("INSERT OR IGNORE INTO local_device VALUES(1,?,?,?,?)", [
        crypto.randomUUID(),
        crypto.randomUUID(),
        pub,
        secret,
      ]);
      row = select.get();
    }
    if (!row) throw Error("Cannot open device key");
    const key = await crypto.subtle.importKey(
      "pkcs8",
      Buffer.from(row.secret, "base64url"),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["sign"],
    );
    const deviceId = v.parse(DeviceIdSchema, row.device),
      keyId = v.parse(DeviceKeyIdSchema, row.key_id),
      publicKey = row.public;
    const localCheck = crypto.randomUUID();
    if (!(await verifyP256(publicKey, localCheck, await signP256(key, localCheck))))
      throw Error("Device key unavailable");
    function load(id: EnvironmentIdentity["id"]) {
      const item = db
        .query<{ body: string }, [string]>("SELECT body FROM registrations WHERE env=?")
        .get(id);
      return item ? v.parse(DeviceRegistrationSchema, JSON.parse(item.body)) : null;
    }
    function save(registration: DeviceRegistration) {
      db.run("INSERT OR REPLACE INTO registrations VALUES(?,?)", [
        registration.identity.id,
        JSON.stringify(registration),
      ]);
    }
    return {
      deviceId,
      keyId,
      publicKey,
      sign: (text: string) => signP256(key, text),
      load,
      close: () => db.close(true),
      saveHostRegistration(input: Extract<DeviceRegistration, { kind: "registered" }>) {
        const row = v.parse(DeviceRegistrationSchema, input);
        if (
          row.deviceId !== deviceId ||
          row.keyId !== keyId ||
          row.publicKey !== publicKey ||
          row.kind !== "registered" ||
          row.deviceKey.publicKey !== publicKey ||
          row.deviceKey.deviceId !== deviceId ||
          row.principal.deviceId !== deviceId ||
          row.deviceKey.id !== keyId
        )
          throw Error("Host registration does not match local key");
        const previous = load(row.identity.id);
        if (
          previous &&
          (!sameEnvironmentIdentity(previous.identity, row.identity) ||
            previous.kind !== "registered" ||
            previous.principal.id !== row.principal.id)
        )
          throw Error("Host registration conflicts with pinned device");
        save(row);
      },
      freeze(command: RouteCommand): RouteCommand {
        const intent = canonicalJson(command);
        return db
          .transaction(() => {
            db.run("INSERT OR IGNORE INTO commands VALUES(?,?)", [command.commandId, intent]);
            if (
              db
                .query<{ intent: string }, [string]>("SELECT intent FROM commands WHERE id=?")
                .get(command.commandId)?.intent !== intent
            )
              throw Error("Command ID already belongs to another intent");
            return JSON.parse(intent) as RouteCommand;
          })
          .immediate();
      },
      prepare(
        identity: EnvironmentIdentity,
        projectId: ProjectId,
        inviteId: PairingInviteId,
        permissions: PermissionItem[],
      ) {
        return db
          .transaction(() => {
            const current = load(identity.id);
            if (current) {
              if (
                current.kind !== "pendingExchange" ||
                !sameEnvironmentIdentity(current.identity, identity) ||
                current.inviteId !== inviteId ||
                current.target.projectId !== projectId ||
                canonicalJson(current.requestedPermissions) !== canonicalJson(permissions)
              )
                throw Error("Device registration conflict");
              return current;
            }
            const pending: PendingRegistration = {
              kind: "pendingExchange",
              identity,
              deviceId,
              keyId,
              publicKey,
              target: { kind: "project", projectId },
              requestId: v.parse(PairingRequestIdSchema, crypto.randomUUID()),
              inviteId,
              requestedPermissions: [...permissions],
              claimId: null,
            };
            save(pending);
            return pending;
          })
          .immediate();
      },
      claim(record: PendingRegistration, frame: PairingChallenge) {
        return db
          .transaction(() => {
            const row = load(record.identity.id);
            if (
              row?.kind !== "pendingExchange" ||
              frame.requestId !== row.requestId ||
              row.requestId !== record.requestId ||
              (row.claimId !== null && row.claimId !== frame.claimId)
            )
              throw Error("Pairing claim conflict");
            const claimed = { ...row, claimId: frame.claimId };
            save(claimed);
            return claimed;
          })
          .immediate();
      },
      complete(
        record: PendingRegistration,
        identity: EnvironmentIdentity,
        result: Extract<
          v.InferOutput<typeof DevicePairingResultSchema>,
          { kind: "pairing.completed" }
        >,
        now = Date.now(),
      ) {
        return db
          .transaction(() => {
            const out = completeLocalPairing(load(identity.id), record, identity, result, now);
            if (out.kind === "conflict") throw Error("Completion does not match local device");
            if (out.kind === "store") save(out.registration);
            return out.registration;
          })
          .immediate();
      },
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
export type LocalDevice = Awaited<ReturnType<typeof openDeviceCredentials>>;

export async function pairingConnection(origin: string, pin: EnvironmentIdentity) {
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const url = new URL(origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/ws";
  url.search = `?nonce=${nonce}`;
  const ws = new WebSocket(url.href);
  const queue: unknown[] = [];
  let changed = Promise.withResolvers<void>(),
    closed = false;
  const signal = () => {
    changed.resolve();
    changed = Promise.withResolvers<void>();
  };
  ws.onmessage = (e) => {
    try {
      if (typeof e.data !== "string" || queue.length > 16) throw Error();
      queue.push(JSON.parse(e.data));
      signal();
    } catch {
      ws.close(1007);
    }
  };
  ws.onerror = ws.onclose = () => {
    closed = true;
    signal();
  };
  async function next<T extends v.GenericSchema>(schema: T): Promise<v.InferOutput<T>> {
    while (!queue.length) {
      if (closed) throw Error("Pairing connection closed");
      await changed.promise;
    }
    return v.parse(schema, queue.shift());
  }
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  try {
    const hello = await next(ServerHelloSchema);
    const { identityProof, ...fields } = hello;
    if (
      !sameEnvironmentIdentity(hello.identity, pin) ||
      hello.clientNonce !== nonce ||
      hello.protocolVersion.major !== 1 ||
      !(await verifyP256(pin.publicKey, canonicalJson(fields), identityProof))
    )
      throw Error("Unverified environment hello");
    return {
      hello,
      send,
      next,
      close: () => ws.close(),
      async apply(record: PendingRegistration) {
        if (!sameEnvironmentIdentity(record.identity, pin))
          throw Error("Application belongs to a different environment");
        send({
          kind: "pairing.request",
          environmentId: pin.id,
          inviteId: record.inviteId,
          requestId: record.requestId,
          deviceId: record.deviceId,
          publicKey: record.publicKey,
          target: record.target,
          requestedPermissions: record.requestedPermissions,
        });
        const pending = await next(PairingPendingSchema);
        if (
          pending.inviteId !== record.inviteId ||
          pending.requestId !== record.requestId ||
          pending.environmentId !== pin.id ||
          pending.deviceId !== record.deviceId ||
          pending.publicKey !== record.publicKey ||
          canonicalJson(pending.target) !== canonicalJson(record.target) ||
          canonicalJson(pending.permissions) !== canonicalJson(record.requestedPermissions)
        )
          throw Error("Unexpected applicant summary");
        return pending;
      },
      challenge: () => next(PairingChallengeSchema),
      async proof(local: LocalDevice, record: PendingRegistration, c: PairingChallenge) {
        const claimed = local.claim(record, c);
        const fields: Omit<PairingExchange, "signature"> = {
          kind: "pairing.exchange",
          method: "pairing.exchange",
          protocolVersion: hello.protocolVersion,
          environmentId: pin.id,
          inviteId: claimed.inviteId,
          requestId: claimed.requestId,
          claimId: c.claimId,
          deviceId: local.deviceId,
          deviceKeyId: local.keyId,
          publicKey: local.publicKey,
          challengeId: c.challengeId,
          challenge: c.challenge,
          sequence: 1,
        };
        return { ...fields, signature: await local.sign(canonicalJson(fields)) };
      },
      result: () => next(DevicePairingResultSchema),
    };
  } catch (e) {
    ws.close();
    throw e;
  }
}
