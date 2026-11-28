import { generateKeyPairSync, sign } from "node:crypto";
import * as v from "valibot";
import { createReplayAdapter } from "@kraka/adapter-replay";
import {
  AttemptIdSchema,
  CommandIdSchema,
  CommandReceiptSchema,
  ConnectionChallengeIdSchema,
  ConnectionChallengeSchema,
  ConnectionIdSchema,
  DeliveryIdSchema,
  EnvironmentIdSchema,
  EXECUTOR_TOOL_METHODS,
  ExecutorInstanceIdSchema,
  RequestSignerSchema,
  SignedRequestSchema,
  canonicalJson,
  type CommandReceipt,
} from "@kraka/protocol";

const toolNames = Object.keys(EXECUTOR_TOOL_METHODS);
function toolName(name: string): name is keyof typeof EXECUTOR_TOOL_METHODS {
  return Object.hasOwn(EXECUTOR_TOOL_METHODS, name);
}
const configuration = v.strictObject({
  environmentId: EnvironmentIdSchema,
  connectionId: ConnectionIdSchema,
  challengeId: ConnectionChallengeIdSchema,
  challenge: ConnectionChallengeSchema,
  signer: RequestSignerSchema.options[1],
});
const tools = v.array(v.strictObject({ name: v.string(), configuration }));
const input = v.variant("kind", [
  v.strictObject({
    kind: v.literal("open"),
    attemptId: AttemptIdSchema,
    directory: v.string(),
    model: v.string(),
  }),
  v.strictObject({ kind: v.literal("provideTools"), tools }),
  v.strictObject({
    kind: v.literal("callTool"),
    name: v.string(),
    payload: v.unknown(),
    commandId: CommandIdSchema,
  }),
  v.strictObject({ kind: v.literal("receipt"), receipt: CommandReceiptSchema }),
  v.strictObject({ kind: v.literal("close") }),
]);

if (import.meta.main) {
  const instance = {
    family: "replay" as const,
    instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
  };
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const { x, y } = publicKey.export({ format: "jwk" });
  if (!x || !y) throw Error("Invalid fixture key");
  const point = Buffer.concat([
    Buffer.from([4]),
    Buffer.from(x, "base64url"),
    Buffer.from(y, "base64url"),
  ]).toString("base64url");
  const installed = new Map<string, v.InferOutput<typeof configuration>>();
  const adapter = createReplayAdapter(undefined, async (_session, offered) => {
    const parsed = v.parse(tools, offered);
    if (parsed.some((t) => !toolNames.includes(t.name))) throw Error("Unknown fixture tool");
    installed.clear();
    for (const tool of parsed) installed.set(tool.name, tool.configuration);
  });
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<CommandReceipt>>>();
  type Open = Extract<Awaited<ReturnType<typeof adapter.open>>, { kind: "ok" }>["value"];
  let session: Open | null = null;
  let sequence = 0;
  const report = (event: unknown) => process.send?.(event);
  async function receive(raw: unknown) {
    const message = v.parse(input, raw);
    if (message.kind === "open") {
      if (session) throw Error("Session already open");
      const setup = {
        workingDirectory: message.directory,
        additionalDirectories: [],
        environment: {},
        model: { id: message.model, options: {} },
        permission: { ceiling: "ask", selected: "ask" } as const,
      };
      const result = await adapter.open({
        instance,
        resume: null,
        attemptId: message.attemptId,
        setup,
      });
      if (result.kind !== "ok") throw Error(result.reason);
      session = result.value;
      report({
        kind: "opened",
        ...instance,
        attemptId: session.handle.attemptId,
        epoch: session.epoch,
        nativeSessionId: session.nativeSessionId,
        setup,
        publicKey: point,
      });
      return;
    }
    if (!session) throw Error("Session required");
    switch (message.kind) {
      case "provideTools": {
        const capabilities = await adapter.capabilities(instance);
        if (capabilities.kind !== "ok") throw Error("Missing capabilities");
        const support = capabilities.value.matrix.provideTools;
        if (support.kind === "unsupported") throw Error("Tools unavailable");
        const result = await adapter.invoke(
          session,
          {
            ...instance,
            capability: "provideTools",
            capabilityVersion: capabilities.value.version,
            support,
          },
          {
            kind: "service",
            capability: "provideTools",
            deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
            request: { kind: "provideTools", tools: message.tools },
          },
        );
        if (result.kind !== "ok") throw Error(result.reason);
        report({
          kind: "configured",
          attemptId: session.handle.attemptId,
          names: [...installed.keys()],
        });
        return;
      }
      case "callTool": {
        const config = installed.get(message.name);
        if (!config || !toolName(message.name) || pending.has(message.commandId))
          throw Error("Tool call unavailable");
        const body = {
          ...config,
          kind: "signedRequest",
          protocolVersion: { major: 1, minor: 0 },
          sequence: ++sequence,
          method: EXECUTOR_TOOL_METHODS[message.name].method,
          payload: message.payload,
          commandId: message.commandId,
        };
        const request = v.parse(SignedRequestSchema, {
          ...body,
          signature: sign("sha256", Buffer.from(canonicalJson(body)), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
          }).toString("base64url"),
        });
        const waiter = Promise.withResolvers<CommandReceipt>();
        pending.set(message.commandId, waiter);
        const attemptId = session.handle.attemptId;
        report({ kind: "request", request });
        const receipt = await waiter.promise;
        report({
          kind: "completed",
          attemptId,
          name: message.name,
          commandId: message.commandId,
          receipt,
        });
        return;
      }
      case "receipt": {
        const waiter = pending.get(message.receipt.commandId);
        if (!waiter) throw Error("Unexpected tool receipt");
        pending.delete(message.receipt.commandId);
        waiter.resolve(message.receipt);
        return;
      }
      case "close":
        await adapter.close(session, "shutdown");
        installed.clear();
        process.disconnect?.();
    }
  }
  process.on("message", (msg) => {
    void receive(msg).catch(() => {
      report({ kind: "error" });
      process.exitCode = 1;
      process.disconnect?.();
    });
  });
}
