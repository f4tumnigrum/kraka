import { mkdirSync, realpathSync } from "node:fs";
import { confirmWriter, openReceiptReader, readReceipt } from "@kraka/environment";
import {
  CommandIdSchema,
  type CommandReceipt,
  PrincipalIdSchema,
  type RequestResult,
} from "@kraka/protocol";
import * as v from "valibot";
import { connectFirstSend, fixtureActor } from "./first-send-client";
import { sampleRequest } from "./replay-process";
import { configureLocalOwner } from "./local-owner";
import { launchWriter, productRoot, type Fault } from "./writer-process";
export { configureLocalOwner } from "./local-owner";
export { launchWriter, productRoot, type Fault } from "./writer-process";
export { waitFile } from "./file-signal";
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
  onStage,
}: {
  stateDir: string;
  projectDirectory: string;
  adapter: "replay";
  root?: string;
  point?: Fault;
  executable?: string;
  recording?: string;
  onStage?: (name: string) => void;
  ipc?: (message: unknown) => void;
}) {
  if (adapter !== "replay") throw new Error("Expected replay adapter");
  onStage?.("preparing writer credentials");
  await configureLocalOwner(stateDir);
  mkdirSync(projectDirectory, { recursive: true });
  onStage?.("waiting for the writer to publish and confirm its endpoint");
  const launcher = launchWriter(stateDir, root, point, recording, ipc, executable);
  try {
    const { kind, publication: instance } = await launcher.ready();
    if (kind !== "ready") throw new Error("Expected owned writer");
    onStage?.("connecting to the writer and registering the project");
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
            db.close(true);
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
