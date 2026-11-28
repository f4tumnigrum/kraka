import { createPrivateKey, sign } from "node:crypto";
import * as v from "valibot";
import {
  AttemptIdSchema,
  CommandIdSchema,
  EXECUTOR_TOOL_METHODS,
  RequestSignerSchema,
  type SignedRequest,
} from "@kraka/protocol";
import { connectCommands } from "../../packages/cli-client/src/first-send";
const config = v.object({
  environmentId: v.string(),
  instanceId: v.string(),
  endpoint: v.string(),
  attemptId: AttemptIdSchema,
  signer: RequestSignerSchema.options[1],
  privateKey: v.string(),
});
const message = v.variant("action", [
  v.object({
    action: v.literal("install"),
    attempt: AttemptIdSchema,
    tools: v.array(v.object({ name: v.string(), configuration: config })),
  }),
  v.object({
    action: v.literal("call"),
    attempt: AttemptIdSchema,
    name: v.string(),
    payload: v.unknown(),
    id: CommandIdSchema,
  }),
  v.object({ action: v.literal("close") }),
]);
const sessions = new Map<
  string,
  {
    client: Awaited<ReturnType<typeof connectCommands>>;
    methods: Map<string, SignedRequest["method"]>;
  }
>();
process.on("message", async (raw) => {
  try {
    const msg = v.parse(message, raw);
    if (msg.action === "install") {
      const settings = msg.tools[0]?.configuration;
      if (
        !settings ||
        settings.attemptId !== msg.attempt ||
        !msg.tools.every((t) => Bun.deepEquals(t.configuration, settings))
      )
        throw Error("Invalid private tool configuration");
      const key = createPrivateKey(settings.privateKey);
      const client = await connectCommands(settings, settings.signer, async (bytes) =>
        sign("sha256", Buffer.from(bytes), { key, dsaEncoding: "ieee-p1363" }).toString(
          "base64url",
        ),
      );
      const methods = new Map<string, SignedRequest["method"]>();
      for (const [name, method] of Object.entries(EXECUTOR_TOOL_METHODS))
        if (msg.tools.some((t) => t.name === name)) methods.set(name, method.method);
      sessions.set(msg.attempt, { client, methods });
      process.send?.({ event: "installed", attempt: msg.attempt });
    } else if (msg.action === "call") {
      const session = sessions.get(msg.attempt);
      const method =
        session?.methods.get(msg.name) ?? (msg.name === "readAnswer" ? "todo.readAnswer" : null);
      if (!session || !method) throw Error("Private tool was not installed");
      const { receipt } = await session.client.send(method, msg.payload, msg.id);
      process.send?.({
        event: "completed",
        id: msg.id,
        attempt: msg.attempt,
        name: msg.name,
        receipt,
      });
    } else {
      for (const session of sessions.values()) session.client.close();
      process.disconnect?.();
    }
  } catch (e) {
    process.send?.({ event: "error", reason: e instanceof Error ? e.message : "Peer failure" });
  }
});
process.on("disconnect", () => process.exit(0));
