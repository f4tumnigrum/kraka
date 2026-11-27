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
import { EnvironmentIdSchema, type HostInstanceId } from "@kraka/protocol";
import * as v from "valibot";
import { InstancePublicationSchema, observeWriter, type InstancePublication } from "./migrations";

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
export async function confirmWriter(stateDirectory: string, deadline: number, idle = false) {
  try {
    const { instance, proofKey } = v.parse(
      ownerSchema,
      JSON.parse(readFileSync(join(stateDirectory, "instance.json"), "utf8")),
    );
    const url = new URL(instance.endpoint);
    if (
      url.hostname !== "127.0.0.1" ||
      url.protocol !== "ws:" ||
      url.pathname !== "/commands" ||
      instance.stateDirectory !== stateDirectory
    )
      return null;
    const nonce = randomBytes(24).toString("hex");
    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) return null;
    const response = await fetch(`http://${url.host}/instance/${nonce}${idle ? "?idle" : ""}`, {
      redirect: "error",
      signal: AbortSignal.timeout(Math.min(remaining, 250)),
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
      const idPath = join(stateDirectory, "environment.id");
      if (!existsSync(idPath)) writeAtomic(idPath, crypto.randomUUID());
      const environmentId = v.parse(EnvironmentIdSchema, readFileSync(idPath, "utf8"));
      const identity = { instanceId, environmentId, stateDirectory, version: "0.1.0" };
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
