import { realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  ExecutorInstanceIdSchema,
  InputContentSchema,
  MessageIdSchema,
} from "@kraka/protocol";
import { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import { fixture } from "./replay-process";
const [observation, root] = process.argv.slice(2);
if (!observation || !root) throw new Error("Expected peer observation and product root");
const command = v.parse(
  v.strictObject({
    kind: v.literal("deliverInput"),
    capability: v.literal("submitTextInput"),
    deliveryId: DeliveryIdSchema,
    attemptId: AttemptIdSchema,
    input: v.strictObject({ id: MessageIdSchema, ...InputContentSchema.entries }),
  }),
  await Bun.stdin.json(),
);
const recording = parseReplayRecording(await Bun.file(join(root, fixture)).text());
const adapter = createReplayAdapter(recording);
const cwd = realpathSync.native(".");
const instance = {
  family: "replay",
  instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
} as const;
const session = await adapter.open({
  instance,
  attemptId: command.attemptId,
  resume: null,
  setup: {
    workingDirectory: cwd,
    additionalDirectories: [],
    environment: {},
    model: { id: recording.modelId, options: {} },
    permission: { ceiling: "ask", selected: "ask" },
  },
});
if (session.kind !== "ok") throw new Error(session.reason);
try {
  const result = await adapter.invoke(
    session.value,
    {
      ...instance,
      capability: "submitTextInput",
      support: { kind: "native" },
      capabilityVersion: 1,
    },
    command,
  );
  if (result.kind !== "ok" || result.value.kind !== "written")
    throw new Error("Peer rejected delivery");
  writeFileSync(
    observation,
    JSON.stringify({ cwd, ...command, nativeSessionId: session.value.nativeSessionId }),
    { flag: "wx" },
  );
  const events = [];
  for await (const event of adapter.events(session.value, null)) events.push(event);
  console.log(JSON.stringify(events));
} finally {
  await adapter.close(session.value, "finished");
}
