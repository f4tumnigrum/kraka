import { ownedDirectory } from "@kraka/cli-client";
import { Database } from "bun:sqlite";
import {
  randomInt,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import * as v from "valibot";
import {
  directoryEnvironmentId,
  AccessStore,
  accessTables,
  markStartupDetail,
  type HostDecision,
  type TrustedHostPairing,
} from "@kraka/environment";
import {
  EnvironmentIdentitySchema,
  EnvironmentIdSchema,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  CommandIdSchema,
  P256PublicKeySchema,
  ObjectVersionSchema,
  base64url,
} from "@kraka/protocol";
import { listenIdentity, type IdentityPort } from "./identity";

async function answer(prompt: string, expected: string) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) return false;
  const terminal = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });
  try {
    return (await terminal.question(prompt)) === expected;
  } finally {
    terminal.close();
  }
}
const localDecision: HostDecision = {
  present() {
    const code = randomInt(1_000_000).toString().padStart(6, "0");
    return answer(`Type ${code} to confirm you are at the host terminal: `, code);
  },
  approve(detail) {
    return answer(`${JSON.stringify(detail)}\nType YES to authorize this action: `, "YES");
  },
};
export async function openAccessHost(
  stateDir: string,
  decision: HostDecision = localDecision,
  now = Date.now,
) {
  const dir = await ownedDirectory(resolve(stateDir));
  markStartupDetail("access.directory");
  const filename = join(dir, "access.sqlite");
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    const stat = await lstat(filename + suffix).catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
    if (stat && (!stat.isFile() || stat.nlink !== 1 || stat.isSymbolicLink()))
      throw Error("Invalid state file");
  }
  markStartupDetail("access.files");
  const db = new Database(filename, { create: true });
  try {
    markStartupDetail("access.open");
    db.run("PRAGMA busy_timeout=5000");
    markStartupDetail("access.pragma");
    const row = db
      .transaction(() => {
        db.exec(
          "CREATE TABLE IF NOT EXISTS host_identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1),id TEXT NOT NULL,secret TEXT NOT NULL)",
        );
        markStartupDetail("access.identityTable");
        let row = db
          .query<{ id: string; secret: string }, []>("SELECT id,secret FROM host_identity")
          .get();
        if (row) {
          directoryEnvironmentId(dir, v.parse(EnvironmentIdSchema, row.id));
        } else {
          const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
          row = {
            id: directoryEnvironmentId(dir, null),
            secret: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
          };
          db.run("INSERT INTO host_identity VALUES(1,?,?)", [row.id, row.secret]);
        }
        markStartupDetail("access.identity");
        db.exec(accessTables);
        markStartupDetail("access.tables");
        return row;
      })
      .immediate();
    markStartupDetail("access.commit");
    const key = createPrivateKey(row.secret);
    const { x, y } = createPublicKey(key).export({ format: "jwk" });
    if (!x || !y) throw Error("Invalid environment public key");
    const identity = v.parse(EnvironmentIdentitySchema, {
      id: row.id,
      keyVersion: 1,
      publicKey: base64url(
        Buffer.concat([Buffer.from([4]), Buffer.from(x, "base64url"), Buffer.from(y, "base64url")]),
      ),
    });
    markStartupDetail("access.key");
    const store = new AccessStore(db, identity, now);
    const trusted: TrustedHostPairing = {
      confirm: (input) => store.confirm(input, decision),
      grantOwnerUpgrade: (input) => store.grantOwnerUpgrade(input, decision),
    };
    const version = v.parse(ObjectVersionSchema, "1");
    const port: IdentityPort = {
      identity,
      access: store,
      claimListener() {
        // Only the serving process owns live send authority. Local approvals use the main database.
        const lock = new Database(join(dir, "access-listener.sqlite"), { create: true });
        try {
          lock.exec("PRAGMA busy_timeout=0; BEGIN EXCLUSIVE");
          return () => lock.close(true);
        } catch (e) {
          lock.close(true);
          throw e;
        }
      },
      sign: async (message) =>
        sign("sha256", Buffer.from(message), { key, dsaEncoding: "ieee-p1363" }).toString(
          "base64url",
        ),
      configuration: { environment: { id: identity.id, version }, version, executors: [] },
      registration(signer) {
        if (signer.kind !== "device") return null;
        const d = store.device(signer.deviceId);
        return d
          ? {
              ...d,
              identity,
              deviceId: d.principal.deviceId,
              keyId: d.deviceKey.id,
              publicKey: d.deviceKey.publicKey,
            }
          : null;
      },
      request(actor, request) {
        if (request.method === "device.revoke")
          return store.revokeDevice({ actor, commandId: request.commandId, ...request.payload });
        return store.command(actor, request);
      },
    };
    return { identity, store, trusted, port, close: () => db.close(true) };
  } catch (e) {
    db.close(true);
    throw e;
  }
}

export async function accessCli(args: string[]) {
  const [command, ...rest] = args;
  if (!["serve", "confirm", "recover", "grant-owner-upgrade"].includes(command ?? ""))
    throw Error("Unknown access command");
  const { values } = parseArgs({
    args: rest,
    options: {
      "state-dir": { type: "string" },
      device: { type: "string" },
      key: { type: "string" },
      "public-key": { type: "string" },
      "command-id": { type: "string" },
      port: { type: "string" },
      "allow-origin": { type: "string", multiple: true },
      "public-origin": { type: "string" },
    },
    strict: true,
  });
  if (!values["state-dir"]) throw Error("Expected --state-dir DIR");
  const host = await openAccessHost(values["state-dir"]);
  try {
    if (command === "serve") {
      const port = Number(values.port ?? 0);
      if (!Number.isInteger(port) || port < 0 || port > 65535) throw Error("Invalid port");
      const listener = listenIdentity(
        host.port,
        port,
        values["allow-origin"],
        values["public-origin"],
      );
      const stop = () => {
        void listener.close().finally(host.close);
      };
      process.once("SIGTERM", stop);
      process.once("SIGINT", stop);
      process.stdout.write(
        `${JSON.stringify({ origin: listener.origin, identity: host.identity })}\n`,
      );
      return;
    }
    const deviceId = v.parse(DeviceIdSchema, values.device),
      keyId = v.parse(DeviceKeyIdSchema, values.key);
    if (command === "grant-owner-upgrade") {
      const grant = await host.trusted.grantOwnerUpgrade({
        environmentId: host.identity.id,
        deviceId,
        keyId,
        commandId: v.parse(CommandIdSchema, values["command-id"]),
      });
      if (!grant) throw Error("Owner upgrade grant denied");
      process.stdout.write(`${grant}\n`);
    } else {
      const result = await host.trusted.confirm({
        kind: command === "recover" ? "recover" : "bootstrap",
        environment: host.identity,
        deviceId,
        keyId,
        publicKey: v.parse(P256PublicKeySchema, values["public-key"]),
      });
      if (result === "denied") throw Error("Owner registration denied");
      process.stdout.write(
        `${JSON.stringify({ identity: host.identity, ...host.store.device(deviceId) })}\n`,
      );
    }
    host.close();
  } catch (e) {
    host.close();
    throw e;
  }
}
