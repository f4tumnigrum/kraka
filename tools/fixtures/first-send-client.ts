import { join } from "node:path";
import * as v from "valibot";
import { InstancePublicationSchema, type InstancePublication } from "@kraka/environment";
import { connectCommands } from "../../packages/cli-client/src/first-send";
import { RequestSignerSchema, type ExecutorTurnUpdate } from "@kraka/protocol";
export const fixtureSigner = {
  kind: "device",
  deviceId: "first-send-local-device",
  keyId: "first-send-local-key",
} as const;
export const fixtureActor = "first-send-local-owner";

export function connectFirstSend(
  stateDir: string,
  instance: InstancePublication,
  onUpdate?: (event: ExecutorTurnUpdate) => void,
) {
  return connectCommands(
    instance,
    v.parse(RequestSignerSchema, fixtureSigner),
    join(stateDir, "fixture-private.pem"),
    onUpdate,
  );
}
export async function finishedCapture(
  client: Awaited<ReturnType<typeof connectFirstSend>>,
  target: { threadId: string; roundId: string; attemptId: string },
) {
  const match = (r: import("@kraka/protocol").Round) =>
    r.id === target.roundId &&
    r.attempt.attemptId === target.attemptId &&
    r.attempt.phase.kind === "finished";
  const rounds = await client.subscribedRounds(target.threadId, (rows) => rows.some(match));
  const phase = rounds.find(match)?.attempt.phase;
  if (phase?.kind !== "finished") throw Error("Expected the settled attempt");
  return phase.captureId;
}
if (import.meta.main) {
  const options = v.parse(
    v.object({
      stateDir: v.string(),
      instance: InstancePublicationSchema,
      method: v.string(),
      payload: v.unknown(),
      id: v.string(),
    }),
    await Bun.stdin.json(),
  );
  const client = await connectFirstSend(options.stateDir, options.instance);
  try {
    console.log(JSON.stringify(await client.send(options.method, options.payload, options.id)));
  } finally {
    client.close();
  }
}
