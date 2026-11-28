import { Database } from "bun:sqlite";
import {
  mkdirSync,
  realpathSync,
  readFileSync,
  renameSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { directoryEnvironmentId } from "./environment-identity";
import type { HostInstanceId } from "@kraka/protocol";
import * as v from "valibot";
import { InstancePublicationSchema, observeWriter, type InstancePublication } from "./migrations";

declare const KRAKA_RELEASE_VERSION: string;
function writeAtomic(path: string, value: string) {
  const temp = `${path}.${crypto.randomUUID()}`;
  try {
    writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
const ownerSchema = v.strictObject({
  instance: InstancePublicationSchema,
  proofKey: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
});
function proof(key: string, nonce: string, instance: InstancePublication) {
  return createHmac("sha256", Buffer.from(key, "hex"))
    .update(nonce)
    .update(JSON.stringify(instance))
    .digest("hex");
}
export function confirmWriter(stateDirectory: string, deadline: number, idle = false) {
  return verifyPublication(stateDirectory, Math.min(deadline, performance.now() + 250), idle);
}
async function verifyPublication(stateDirectory: string, deadline: number, idle = false) {
  try {
    const { instance, proofKey } = v.parse(
      ownerSchema,
      JSON.parse(readFileSync(join(stateDirectory, "instance.json"), "utf8")),
    );
    const url = new URL(instance.endpoint);
    if (
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "ws:" ||
      !["/commands", "/ws"].includes(url.pathname) ||
      instance.stateDirectory !== stateDirectory
    )
      return null;
    const nonce = randomBytes(24).toString("hex");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return null;
    const response = await fetch(`http://${url.host}/instance/${nonce}${idle ? "?idle" : ""}`, {
      redirect: "error",
      signal: AbortSignal.timeout(remaining),
    });
    if (!response.ok) return null;
    const answer = await response.text();
    if (
      !/^[a-f0-9]{64}$/.test(answer) ||
      !timingSafeEqual(
        Buffer.from(answer),
        Buffer.from(proof(proofKey, nonce + (idle ? "?idle" : ""), instance)),
      )
    )
      return null;
    const current = v.parse(
      ownerSchema,
      JSON.parse(readFileSync(join(stateDirectory, "instance.json"), "utf8")),
    );
    return Bun.deepEquals(current.instance, instance) ? instance : null;
  } catch {
    return null;
  }
}
export async function readInstancePublication(stateDir: string) {
  let db: Database | undefined;
  let directory: string | undefined;
  try {
    directory = realpathSync.native(stateDir);
    if (!existsSync(join(directory, "instance.json"))) return null;
    db = new Database(join(directory, "writer.lock.sqlite"), { readonly: true });
    db.query("SELECT count(*) FROM sqlite_master").get();
    return null;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY")) return null;
    return directory ? verifyPublication(directory, performance.now() + 10_000) : null;
  } finally {
    db?.close(true);
  }
}
export async function openWriter(stateDir: string, instanceId: HostInstanceId, deadline: number) {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const stateDirectory = realpathSync.native(stateDir);
  const db = new Database(join(stateDirectory, "writer.lock.sqlite"), { create: true });
  const publicationPath = join(stateDirectory, "instance.json");
  try {
    while (performance.now() < deadline) {
      const nextPoll = Math.min(deadline, performance.now() + 50);
      db.run(
        "PRAGMA busy_timeout=" +
          Math.max(0, Math.min(50, Math.floor(deadline - performance.now()))),
      );
      try {
        db.run("BEGIN EXCLUSIVE");
      } catch (error) {
        if (
          !error ||
          typeof error !== "object" ||
          !("code" in error) ||
          error.code !== "SQLITE_BUSY"
        )
          throw error;
        const instance = await confirmWriter(stateDirectory, deadline);
        if (instance) {
          db.close();
          return { kind: "existingInstance" as const, instance };
        }
        await Bun.sleep(Math.max(0, nextPoll - performance.now()));
        continue;
      }
      const environmentId = directoryEnvironmentId(stateDirectory);
      const identity = {
        instanceId,
        environmentId,
        stateDirectory,
        version: typeof KRAKA_RELEASE_VERSION === "string" ? KRAKA_RELEASE_VERSION : "0.1.0",
      };
      const decision = observeWriter(identity, { kind: "acquired", owner: identity });
      if (decision.kind !== "writer") throw new Error("Cannot confirm directory writer");
      let published: InstancePublication | null = null;
      const key = randomBytes(32).toString("hex");
      return {
        kind: "writer" as const,
        lease: decision.lease,
        publish(endpoint: string) {
          published = v.parse(InstancePublicationSchema, {
            ...identity,
            endpoint,
            pid: process.pid,
          });
          writeAtomic(publicationPath, JSON.stringify({ instance: published, proofKey: key }));
          return published;
        },
        confirm(nonce: string) {
          return published ? proof(key, nonce, published) : null;
        },
        close() {
          try {
            if (published && existsSync(publicationPath)) {
              const current = v.parse(
                ownerSchema,
                JSON.parse(readFileSync(publicationPath, "utf8")),
              );
              if (current.instance.instanceId === instanceId) rmSync(publicationPath);
            }
          } finally {
            db.close();
          }
        },
      };
    }
    db.close();
    return {
      kind: "unconfirmed" as const,
      reason: "writer present, endpoint unconfirmed" as const,
    };
  } catch (e) {
    db.close();
    throw e;
  }
}
