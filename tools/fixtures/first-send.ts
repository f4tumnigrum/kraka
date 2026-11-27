import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  confirmWriter,
  InstancePublicationSchema,
  type InstancePublication,
  openReceiptReader,
  readReceipt,
} from "@kraka/environment";
import {
  CommandIdSchema,
  type CommandReceipt,
  PrincipalIdSchema,
  type RequestResult,
} from "@kraka/protocol";
import { ownedDirectory } from "../../packages/cli-client/src/private-directory";
import * as v from "valibot";
import { connectFirstSend, fixtureActor, fixtureSigner } from "./first-send-client";
import { entry, fixture, sampleRequest, terminate, within } from "./replay-process";

export const productRoot = resolve(import.meta.dir, "../..");
export type Fault =
  | "locked"
  | "beforeCommit"
  | "afterCommit"
  | "externalWrite"
  | "peer"
  | "claimed"
  | "registered"
  | "beforeSetup"
  | "setupExited"
  | "resume"
  | "recovery";
export async function configureLocalOwner(
  stateDir: string,
  permissions = ["workspace.change", "thread.send", "thread.view"],
) {
  await ownedDirectory(stateDir);
  const privatePath = join(stateDir, "fixture-private.pem");
  if (existsSync(privatePath)) return;
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
    publicKeyEncoding: { format: "pem", type: "spki" },
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
  });
  writeFileSync(privatePath, privateKey, { mode: 0o600, flag: "wx" });
  writeFileSync(
    join(stateDir, "local-owner.json"),
    JSON.stringify({
      publicKey,
      signer: fixtureSigner,
      principalId: fixtureActor,
      permissions,
    }),
    { mode: 0o600, flag: "wx" },
  );
}
export function launchWriter(
  stateDir: string,
  root: string,
  point?: Fault | "codex" | "codex-cli",
  recording = join(root, fixture),
  ipc?: (message: unknown) => void,
  executable?: string,
) {
  const argv =
    point === "codex-cli"
      ? [join(root, entry), "start", "--state-dir", stateDir]
      : point === "codex"
        ? [join(root, "tools/fixtures/codex-writer.ts"), stateDir]
        : point
          ? [join(root, "tools/fixtures/first-send-writer.ts"), stateDir, root, point]
          : [join(root, entry), "start", "--state-dir", stateDir, "--recording", recording];
  const started = performance.now();
  const child = Bun.spawn(
    executable ? [executable, ...argv.slice(1)] : [process.execPath, ...argv],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      ...(ipc && { ipc }),
    },
  );
  const stderr = new Response(child.stderr).text();
  const line = Promise.withResolvers<string>();
  const drained = (async () => {
    let out = "";
    for await (const data of child.stdout) {
      out += new TextDecoder().decode(data);
      if (out.includes("\n")) line.resolve(out.split("\n")[0] ?? "");
    }
    line.reject(new Error(`Writer exited: ${await stderr}`));
  })();
  void line.promise.catch(() => {});
  const ready = async () => {
    const raw = await within(line.promise, 11000, "Writer publication");
    const result = v.parse(
      v.strictObject({
        kind: v.picklist(["ready", "existingInstance"]),
        instance: InstancePublicationSchema,
      }),
      JSON.parse(raw),
    );
    const deadline = performance.now() + 10000;
    let confirmed: InstancePublication | null;
    do {
      confirmed = await confirmWriter(realpathSync.native(stateDir), deadline);
      if (!confirmed) await Bun.sleep(10);
    } while (!confirmed && performance.now() < deadline);
    if (
      !Bun.deepEquals(confirmed, result.instance) ||
      (result.kind === "ready" && result.instance.pid !== child.pid)
    )
      throw new Error("Unconfirmed writer");
    return result;
  };
  return {
    child,
    started,
    ready,
    async stop() {
      await terminate(child);
      await Promise.all([drained, stderr]);
    },
    async kill() {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      await Promise.all([drained, stderr]);
    },
  };
}
export function accepted<K extends RequestResult["kind"]>(
  receipt: CommandReceipt,
  kind: K,
): Extract<RequestResult, { kind: K }> {
  if (receipt.kind !== "accepted" || receipt.result.kind !== kind)
    throw new Error(`Expected ${kind}, got ${JSON.stringify(receipt)}`);
  return receipt.result as Extract<RequestResult, { kind: K }>;
}
export async function startFirstSendFixture({
  stateDir,
  projectDirectory,
  adapter,
  root = productRoot,
  point,
  executable,
  recording,
  ipc,
}: {
  stateDir: string;
  projectDirectory: string;
  adapter: "replay";
  root?: string;
  point?: Fault;
  executable?: string;
  recording?: string;
  ipc?: (message: unknown) => void;
}) {
  if (adapter !== "replay") throw new Error("Expected replay adapter");
  await configureLocalOwner(stateDir);
  mkdirSync(projectDirectory, { recursive: true });
  const launcher = launchWriter(stateDir, root, point, recording, ipc, executable);
  try {
    const { kind, instance } = await launcher.ready();
    if (kind !== "ready") throw new Error("Expected owned writer");
    const client = await connectFirstSend(stateDir, instance);
    try {
      const { receipt } = await client.send("project.register", {
        realPath: realpathSync.native(projectDirectory),
      });
      const project = accepted(receipt, "projectRegistered").project;
      const payload = { projectId: project.id, worktreeId: null, content: sampleRequest.input };
      return {
        ...launcher,
        instance,
        endpoint: instance.endpoint,
        async awaitRecovery(instanceId: string) {
          const observed = await confirmWriter(instance.stateDirectory, performance.now() + 1000);
          if (observed?.instanceId !== instanceId) throw Error("Recovery publication changed");
        },
        client,
        project,
        payload,
        send: (id?: string) => client.send("thread.start", payload, id),
        receipt(command: string) {
          const db = openReceiptReader(stateDir);
          try {
            return readReceipt(
              db,
              v.parse(PrincipalIdSchema, fixtureActor),
              v.parse(CommandIdSchema, command),
            );
          } finally {
            db.close();
          }
        },
        async close() {
          client.close();
          await launcher.stop();
        },
      };
    } catch (e) {
      client.close();
      throw e;
    }
  } catch (e) {
    await launcher.stop();
    throw e;
  }
}
export async function waitFile(path: string) {
  const until = performance.now() + 8000;
  while (!existsSync(path)) {
    if (performance.now() >= until) throw new Error(`Missing ${path}`);
    await Bun.sleep(5);
  }
}
