import * as v from "valibot";
import type {
  ActionPermit,
  AdapterCapability,
  AdapterCallResult,
  AdapterCommand,
  AdapterInstance,
  AdapterSession,
  CapabilityDeclaration,
  InstanceServiceCommand,
  InstanceServiceResult,
  InvocationResult,
  ProviderAdapter,
  SessionInvocationResult,
} from "@kraka/environment";
import type { AcpConnection, AcpLaunchSpec, AcpTransport } from "./acp";
import { AcpDuplex, type Reply } from "./rpc";
import { initialized, newSession, validated, authMessage, sessionUpdate } from "./native";
import { AcpSessionHandle } from "./session";
import { acpCapabilities } from "./capabilities";
export { AcpSessionHandle } from "./session";
export type AcpAdapterFactory = (
  transport: AcpTransport<AcpConnection>,
) => ProviderAdapter<"acp", AcpSessionHandle>;
type Instance = AdapterInstance<"acp">;
type Session = AdapterSession<"acp", AcpSessionHandle>;
type Options = {
  instance: Instance;
  launch: AcpLaunchSpec;
  declaration: CapabilityDeclaration<"acp">;
  previousEpoch: number;
};
const rejected = (
  reason:
    | "unsupported"
    | "wrongFamily"
    | "notFound"
    | "invalidState"
    | "invalidCapabilitySnapshot"
    | "notAuthenticated",
  message: string | null = null,
) => ({ kind: "rejected", reason, message }) as const;
export function rpcResult(r: Reply) {
  if ("code" in r) throw new Error(r.code === -32000 ? authMessage : "ACP request rejected");
  return r.result;
}
export async function initializeAcp(rpc: AcpDuplex) {
  const call = rpc.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
  await call.written;
  return validated(initialized, rpcResult(await call.reply));
}
export function createAcpAdapter(
  transport: AcpTransport<AcpConnection>,
  options?: Options,
): ProviderAdapter<"acp", AcpSessionHandle> {
  let epoch = options?.previousEpoch ?? 0;
  const owned = new WeakSet<AcpSessionHandle>();
  const declaration = options?.declaration ?? acpCapabilities(Date.now());
  function matches(i: Instance) {
    return i.family === "acp" && (!options || options.instance.instanceId === i.instanceId);
  }
  async function invoke<C extends InstanceServiceCommand>(
    i: Instance,
    p: ActionPermit<"acp", C["capability"]>,
    c: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  async function invoke<C extends AdapterCommand>(
    s: Session,
    p: ActionPermit<"acp", C["capability"]>,
    c: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  async function invoke(
    s: Session | Instance,
    p: ActionPermit<"acp", AdapterCapability>,
    c: AdapterCommand,
  ): Promise<AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>> {
    if (!matches(s) || p.family !== s.family) return rejected("wrongFamily");
    if (
      p.instanceId !== s.instanceId ||
      p.capability !== c.capability ||
      p.capabilityVersion !== declaration.version
    )
      return rejected("invalidState");
    if (c.capability === "generateText" || declaration.matrix[c.capability].kind === "unsupported")
      return rejected("unsupported");
    if (!("handle" in s) || !owned.has(s.handle)) return rejected("notFound");
    return s.handle.invoke(c);
  }
  return {
    invoke,
    async capabilities(i) {
      return matches(i) ? { kind: "ok", value: declaration } : rejected("wrongFamily");
    },
    async open({ instance, resume, attemptId, setup }) {
      if (!matches(instance)) return rejected("wrongFamily");
      if (
        (resume !== null &&
          declaration.matrix.resumeSessionAfterProcessExit.kind === "unsupported") ||
        setup.additionalDirectories.length ||
        setup.permission.selected !== "ask" ||
        setup.model.id !== "default" ||
        Object.keys(setup.model.options).length
      )
        return rejected("unsupported");
      if (options && options.launch.workingDirectory !== setup.workingDirectory)
        return rejected("invalidState");
      const spec = options?.launch ?? {
        command: instance.instanceId,
        args: [],
        workingDirectory: setup.workingDirectory,
        environment: setup.environment,
      };
      const connection = await transport.open(spec);
      if (connection.kind === "rejected") return connection;
      const rpc = new AcpDuplex(transport, connection.value);
      try {
        const negotiation = await initializeAcp(rpc);
        const caps = negotiation.agentCapabilities;
        const method =
          resume === null
            ? "session/new"
            : caps.sessionCapabilities?.resume
              ? "session/resume"
              : caps.loadSession
                ? "session/load"
                : null;
        if (!method) {
          await rpc.close();
          return rejected("unsupported");
        }
        const call = rpc.request(method, {
          cwd: setup.workingDirectory,
          mcpServers: [],
          ...(resume ? { sessionId: resume } : {}),
        });
        if (method === "session/load")
          rpc.onNotice = (kind, params) => {
            if (kind === "session/update" && sessionUpdate(params)?.sessionId === resume)
              rpc.refreshDeadline(call.id);
          };
        await call.written;
        const result = rpcResult(await call.reply);
        const sessionId = resume === null ? validated(newSession, result).sessionId : resume;
        if (resume !== null)
          validated(v.object({ sessionId: v.optional(v.literal(resume)) }), result);
        if (rpc.failure) throw rpc.failure;
        const handle = new AcpSessionHandle(
          rpc,
          instance,
          sessionId,
          attemptId,
          ++epoch,
          crypto.randomUUID(),
        );
        owned.add(handle);
        return { kind: "ok", value: { ...instance, epoch, nativeSessionId: sessionId, handle } };
      } catch (e) {
        await rpc.close();
        return e instanceof Error && e.message === authMessage
          ? rejected("notAuthenticated", authMessage)
          : rejected("invalidState", "ACP v1 negotiation or session creation failed");
      }
    },
    events(session, after) {
      if (!owned.has(session.handle) || after !== null) throw Error("ACP event stream unavailable");
      return session.handle.events();
    },
    async close(session) {
      return owned.has(session.handle) ? session.handle.close() : rejected("notFound");
    },
  };
}
