import { traceClaudeChild } from "./child-timing";
import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CapabilityMatrixSchema,
  InstancePermissionSchema,
  NativeSessionIdSchema,
  type CapabilityId,
  type ExecutorInstanceId,
} from "@kraka/protocol";
import type {
  ActionPermit,
  AdapterCapability,
  AdapterCommand,
  AdapterCallResult,
  AdapterInstance,
  AdapterSession,
  CapabilityDeclaration,
  InstanceServiceCommand,
  InstanceServiceResult,
  InvocationResult,
  ProviderAdapter,
  SessionInvocationResult,
} from "@kraka/environment";
import { ClaudeCodeSessionHandle, within } from "./session";
import { sameBinding, ok, rejected } from "./approvals";
import sdk from "../node_modules/@anthropic-ai/claude-agent-sdk/package.json";
export { ClaudeCodeSessionHandle } from "./session";
export type ClaudeCodeAdapterFactory = () => ProviderAdapter<
  "claude-code",
  ClaudeCodeSessionHandle
>;
type Instance = AdapterInstance<"claude-code">;
type Session = AdapterSession<"claude-code", ClaudeCodeSessionHandle>;
export type ClaudeLaunch = {
  executable: string;
  instanceId?: ExecutorInstanceId;
  previousEpoch?: number;
  verifiedCli?: { executable: string; version: string };
  capabilityVersion?: number;
  environment?: Readonly<Record<string, string>>;
};
const supported = new Set<CapabilityId>([
  "startSession",
  "submitTextInput",
  "streamResponse",
  "reportToolActivity",
  "reportRoundEnd",
  "reportFileChanges",
  "stopRound",
  "requestCommandApproval",
  "requestFileApproval",
  "answerApprovalChoices",
  "selectPermissionMode",
  "configureWorkspace",
  "configureEnvironment",
]);
function capabilities(version: number): CapabilityDeclaration<"claude-code"> {
  const unsupported = {
    kind: "unsupported",
    reason: "Unavailable in this Claude SDK integration",
  } as const;
  const unknown = { state: "unknown", verifiedAt: null } as const;
  const steer = { support: unsupported, readReceipt: "no", accepts: [] } as const;
  const none = { receipt: "none", deduplicate: "none", query: "none" } as const;
  return {
    family: "claude-code",
    version,
    checkedAt: Date.now(),
    readiness: {
      configured: unknown,
      installed: unknown,
      authenticated: unknown,
      model: unknown,
      operation: unknown,
    },
    matrix: v.parse(
      CapabilityMatrixSchema,
      Object.fromEntries(
        CAPABILITY_IDS.map((key) => [key, supported.has(key) ? { kind: "native" } : unsupported]),
      ),
    ),
    input: { ...none, receipt: "proof" },
    answer: none,
    steering: { queueNext: steer, insertCurrent: steer, restartCurrent: steer },
    requests: {
      approval: { afterSessionLoss: "liveOnly" },
      question: { afterSessionLoss: "notResumable" },
    },
    permission: {
      modes: ["ask", "edits", "open"],
      enforcement: "native",
      changeEffective: "restart",
    },
    endReasons: ["completed", "stopped", "failed", "unknown"],
    childWork: "unsupported",
  };
}
export async function claudeCliVersion(
  executable: string,
  cwd: string,
  env: Readonly<Record<string, string>>,
) {
  const trace = traceClaudeChild(executable, "version");
  const child = Bun.spawn([executable, "--version"], {
    cwd,
    env: { ...env },
    stdin: "ignore",
    stdout: "pipe",
    stderr: trace ? "pipe" : "ignore",
  });
  trace?.spawn(child.pid);
  const errors = (async () => {
    if (trace && child.stderr)
      for await (const chunk of child.stderr) trace.stderr(child.pid, chunk);
  })();
  try {
    const [code, output] = await within(
      Promise.all([child.exited, new Response(child.stdout).text()]),
      10000,
    );
    return code === 0 ? (/^(\d+\.\d+\.\d+)(?:\s|$)/.exec(output.trim())?.[1] ?? null) : null;
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await child.exited;
    await errors;
    trace?.exit(child.pid, child.exitCode, child.signalCode);
  }
}
export function createClaudeCodeAdapter(
  launch?: ClaudeLaunch,
): ProviderAdapter<"claude-code", ClaudeCodeSessionHandle> {
  const owned = new WeakSet<ClaudeCodeSessionHandle>();
  const epochs = new Map<ExecutorInstanceId, number>();
  const version = launch?.capabilityVersion ?? 1;
  const valid = (i: Instance) => !launch?.instanceId || launch.instanceId === i.instanceId;
  async function invoke<C extends InstanceServiceCommand>(
    i: Instance,
    p: ActionPermit<"claude-code", NoInfer<C["capability"]>>,
    c: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  async function invoke<C extends AdapterCommand>(
    s: Session,
    p: ActionPermit<"claude-code", NoInfer<C["capability"]>>,
    c: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    target: Instance | Session,
    permit: ActionPermit<"claude-code", AdapterCapability>,
    cmd: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>> {
    if (target.family !== "claude-code" || permit.family !== target.family)
      return rejected("wrongFamily");
    if (!valid(target) || target.instanceId !== permit.instanceId) return rejected("notFound");
    if ("handle" in target) {
      if (!owned.has(target.handle) || !sameBinding(target, target.handle.binding))
        return rejected("notFound");
      if (target.handle.closed) return rejected("alreadyClosed");
    }
    if (
      !Number.isSafeInteger(permit.capabilityVersion) ||
      !permit.support ||
      !["native", "substitute"].includes(permit.support.kind)
    )
      return rejected("invalidCapabilitySnapshot");
    if (permit.capabilityVersion !== version || permit.capability !== cmd.capability)
      return rejected("invalidState");
    if (
      !("handle" in target) ||
      cmd.capability === "generateText" ||
      !supported.has(cmd.capability)
    )
      return rejected("unsupported");
    const h = target.handle;
    switch (cmd.kind) {
      case "deliverInput":
        return h.deliver(cmd);
      case "stop":
        return h.stop(cmd);
      case "deliverAnswer": {
        if (
          !cmd.reply ||
          cmd.answer.content.kind !== "message" ||
          cmd.answer.deliveryId !== cmd.deliveryId ||
          cmd.answer.attemptId !== cmd.attemptId
        )
          return rejected("invalidState");
        const toolUseId = h.approvals.toolForAnswer(cmd.requestId, cmd.deliveryId);
        if (!toolUseId) return rejected("requestExpired");
        return h.resolveTool({
          binding: h.binding,
          requestId: cmd.requestId,
          toolUseId,
          deliveryId: cmd.deliveryId,
          answer: cmd.reply,
        });
      }
      default:
        return rejected("unsupported");
    }
  }
  return {
    invoke,
    async capabilities(i) {
      if (i.family !== "claude-code") return rejected("wrongFamily");
      return valid(i) ? ok(capabilities(version)) : rejected("notFound");
    },
    async open({ instance, setup, attemptId, resume }) {
      if (instance.family !== "claude-code") return rejected("wrongFamily");
      if (!valid(instance)) return rejected("notFound");
      if (
        resume ||
        !v.safeParse(InstancePermissionSchema, setup.permission).success ||
        Object.keys(setup.model.options).length
      )
        return rejected("unsupported");
      setup = { ...setup, environment: { ...setup.environment, ...launch?.environment } };
      const executable = Bun.which(launch?.executable ?? "claude", {
        cwd: setup.workingDirectory,
        PATH: setup.environment.PATH ?? process.env.PATH ?? "",
      });
      if (!executable) return rejected("notFound", "Claude executable unavailable");
      const cliVersion =
        launch?.verifiedCli?.executable === executable
          ? launch.verifiedCli.version
          : await claudeCliVersion(executable, setup.workingDirectory, setup.environment).catch(
              () => null,
            );
      if (!cliVersion) return rejected("unsupported", "Claude executable version unavailable");
      const epoch = (epochs.get(instance.instanceId) ?? launch?.previousEpoch ?? 0) + 1;
      const binding = {
        ...instance,
        epoch,
        nativeSessionId: v.parse(NativeSessionIdSchema, crypto.randomUUID()),
      };
      epochs.set(instance.instanceId, epoch);
      const handle = new ClaudeCodeSessionHandle(
        binding,
        attemptId,
        setup,
        executable,
        sdk.version,
        cliVersion,
      );
      owned.add(handle);
      handle.start();
      return ok({ ...binding, handle });
    },
    events(s, after) {
      if (!owned.has(s.handle) || !sameBinding(s, s.handle.binding))
        throw Error("Foreign Claude session");
      return s.handle.events(after);
    },
    async close(s) {
      if (!owned.has(s.handle) || !sameBinding(s, s.handle.binding)) return rejected("notFound");
      await s.handle.close();
      return ok(undefined);
    },
  };
}
