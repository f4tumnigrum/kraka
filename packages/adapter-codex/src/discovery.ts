import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, isAbsolute, sep } from "node:path";
import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CodexEffectivePolicySchema,
  canonicalJson,
  CapabilityMatrixSchema,
  NativeSessionIdSchema,
  type CapabilityId,
  type NativeSessionId,
  type PermissionMode,
  type ExecutorRefreshed,
} from "@kraka/protocol";
import type { CapabilityDeclaration, ExecutorRegistration, SessionSetup } from "@kraka/environment";
import { verifiedQuotaAccount } from "./account-usage";
import { CodexConnection, type Launch } from "./stdio";
import { NativeError, object } from "./native";

type Catalog = NonNullable<ExecutorRefreshed["models"]>;
export type CodexProbe = {
  declaration: CapabilityDeclaration<"codex">;
  accountContext: string | null;
  quotaAccount?: string | null;
  nativeHome: string | null;
  historyRoot: string | null;
  models: Catalog | null;
  binaryVersion: string | null;
  compatibilityAdvisory: ExecutorRefreshed["compatibilityAdvisory"];
  versionAdvisory: string | null;
  retryAt: number;
  transient: boolean;
};
const basic: CapabilityId[] = [
  "startSession",
  "submitTextInput",
  "streamResponse",
  "reportToolActivity",
  "reportRoundEnd",
  "selectPermissionMode",
  "declareSandboxEnforcement",
];
function declaration(
  version: number,
  checkedAt: number,
  readiness: ExecutorRefreshed["readiness"],
  supported: Set<CapabilityId>,
  mode: PermissionMode,
): CapabilityDeclaration<"codex"> {
  const unsupported = {
    kind: "unsupported",
    reason: "Unavailable in this instance's verified basic protocol",
  } as const;
  const none = { receipt: "none", deduplicate: "none", query: "none" } as const;
  const steer = { support: unsupported, readReceipt: "no", accepts: [] } as const;
  const request = { afterSessionLoss: "notResumable" } as const;
  return {
    family: "codex",
    version,
    checkedAt,
    readiness,
    matrix: v.parse(
      CapabilityMatrixSchema,
      Object.fromEntries(
        CAPABILITY_IDS.map((id) => [id, supported.has(id) ? { kind: "native" } : unsupported]),
      ),
    ),
    input: { ...none, receipt: "proof" },
    answer: none,
    steering: {
      queueNext: steer,
      insertCurrent: supported.has("steerCurrentRound")
        ? { support: { kind: "native" }, readReceipt: "no", accepts: ["text"] }
        : steer,
      restartCurrent: steer,
    },
    requests: { approval: request, question: { afterSessionLoss: "messageFallback" } },
    permission: {
      modes: supported.has("selectPermissionMode") ? [mode] : [],
      enforcement: supported.has("declareSandboxEnforcement") ? "native" : "unknown",
      changeEffective: "now",
    },
    endReasons: ["completed", "failed", "stopped", "unknown"],
    childWork: "unsupported",
  };
}
const pageSchema = v.object({
  nextCursor: v.nullable(v.string()),
  data: v.array(
    v.object({
      id: v.string(),
      model: v.string(),
      displayName: v.string(),
      isDefault: v.boolean(),
      supportedReasoningEfforts: v.array(v.object({ reasoningEffort: v.string() })),
      supportedServiceTiers: v.optional(
        v.array(v.union([v.string(), v.object({ id: v.string() })])),
      ),
      unavailableReason: v.optional(v.nullable(v.string())),
    }),
  ),
});
export async function listModels(rpc: CodexConnection): Promise<Catalog> {
  const models: Catalog["models"] = [],
    seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const page: v.InferOutput<typeof pageSchema> = v.parse(
      pageSchema,
      await rpc.request("model/list", { cursor, limit: 100 }),
    );
    for (const m of page.data) {
      const options: Catalog["models"][number]["options"] = {};
      if (m.supportedReasoningEfforts.length)
        options.effort = {
          kind: "enum",
          values: m.supportedReasoningEfforts.map((r) => r.reasoningEffort),
        };
      if (m.supportedServiceTiers?.length)
        options.serviceTier = {
          kind: "enum",
          values: m.supportedServiceTiers.map((t) => (typeof t === "string" ? t : t.id)),
        };
      models.push({
        id: m.id,
        slug: m.model,
        displayName: m.displayName,
        isDefault: m.isDefault,
        options,
        ...(m.unavailableReason ? { unavailableReason: m.unavailableReason } : {}),
      });
    }
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (seen.has(cursor)) throw new Error("Repeated model cursor");
      seen.add(cursor);
    }
  } while (cursor !== null);
  return { checkedAt: Date.now(), models };
}
export function selectedModel(models: Catalog | null, selection: SessionSetup["model"] | null) {
  const m = selection
    ? models?.models.find((m) => m.id === selection.id || m.slug === selection.id)
    : models?.models.find((m) => m.isDefault);
  if (!m || m.unavailableReason) return null;
  const options = selection?.options ?? {};
  for (const [key, value] of Object.entries(options)) {
    const o = m.options[key];
    if (
      !o ||
      (o.kind === "enum"
        ? typeof value !== "string" || !o.values.includes(value)
        : typeof value !== o.kind)
    )
      return null;
  }
  return { id: m.slug, options };
}
export async function openThread(
  rpc: CodexConnection,
  cwd: string,
  model: SessionSetup["model"],
  probe = false,
  mode: PermissionMode = "ask",
  resume: NativeSessionId | null = null,
  historyRoot: string | null = null,
) {
  const { effort, serviceTier } = model.options;
  const approvalPolicy =
    mode === "ask"
      ? "untrusted"
      : mode === "edits"
        ? "on-request"
        : {
            granular: {
              rules: false,
              sandbox_approval: false,
              skill_approval: false,
              request_permissions: false,
              mcp_elicitations: true,
            },
          };
  const config = {
    ...(effort ? { model_reasoning_effort: effort } : {}),
    ...(mode === "edits"
      ? {
          sandbox_workspace_write: {
            writable_roots: [cwd],
            network_access: false,
            exclude_slash_tmp: true,
            exclude_tmpdir_env_var: true,
          },
        }
      : {}),
  };
  const sandboxMode =
    mode === "ask" ? "read-only" : mode === "edits" ? "workspace-write" : "danger-full-access";
  const r = object(
    await rpc.request(resume ? "thread/resume" : "thread/start", {
      ...(resume ? { threadId: resume } : {}),
      cwd,
      model: model.id,
      approvalPolicy,
      approvalsReviewer: "user",
      sandbox: sandboxMode,
      ...(Object.keys(config).length ? { config } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(probe ? { ephemeral: true } : {}),
    }),
  );
  const thread = object(r.thread),
    sandbox = object(r.sandbox);
  if (!probe && historyRoot && thread.path != null) {
    if (typeof thread.path !== "string" || !isAbsolute(thread.path) || !isAbsolute(historyRoot))
      throw new NativeError("invalidState", "Invalid Codex history location");
    const path = relative(historyRoot, thread.path);
    if (path === ".." || path.startsWith(".." + sep) || isAbsolute(path))
      throw new NativeError("invalidState", "Codex history is outside the registered root");
  }
  if (resume && historyRoot && !thread.path)
    throw new NativeError("invalidState", "Missing Codex history location");
  if (
    r.cwd !== cwd ||
    r.model !== model.id ||
    !Bun.deepEquals(r.approvalPolicy, approvalPolicy) ||
    r.approvalsReviewer !== "user" ||
    (resume !== null && thread.id !== resume) ||
    (mode === "ask" && (sandbox.type !== "readOnly" || sandbox.networkAccess !== false)) ||
    (mode === "edits" &&
      (sandbox.type !== "workspaceWrite" ||
        sandbox.networkAccess !== false ||
        !Array.isArray(sandbox.writableRoots) ||
        sandbox.writableRoots.some((r) => r !== cwd))) ||
    (mode === "open" && sandbox.type !== "dangerFullAccess") ||
    (thread.cwd !== undefined && thread.cwd !== cwd) ||
    (thread.model != null && thread.model !== model.id) ||
    (effort !== undefined && r.reasoningEffort !== effort) ||
    (serviceTier !== undefined && r.serviceTier !== serviceTier)
  )
    throw new NativeError("unsupported", "Codex returned incompatible effective session settings");
  return {
    nativeSessionId: v.parse(NativeSessionIdSchema, thread.id),
    history:
      historyRoot && typeof thread.path === "string"
        ? { root: historyRoot, path: thread.path }
        : null,
    policy: v.parse(CodexEffectivePolicySchema, r),
  };
}
async function basicMethods(launch: Launch) {
  const dir = await mkdtemp(join(tmpdir(), "kraka-codex-schema-"));
  try {
    const child = Bun.spawn(
      [launch.executable, "app-server", "generate-json-schema", "--out", dir],
      {
        cwd: launch.cwd,
        env: launch.env,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        timeout: 10000,
      },
    );
    if ((await child.exited) !== 0) return false;
    async function methods(file: string) {
      const schema = object(JSON.parse(await readFile(join(dir, file), "utf8")));
      const names = new Set<string>();
      function resolveRef(raw: unknown): Record<string, unknown> {
        let node = object(raw);
        const seen = new Set<string>();
        while (
          typeof node.$ref === "string" &&
          node.$ref.startsWith("#/") &&
          !seen.has(node.$ref)
        ) {
          seen.add(node.$ref);
          let target: unknown = schema;
          for (const key of node.$ref.slice(2).split("/"))
            target = object(target)[key.replaceAll("~1", "/").replaceAll("~0", "~")];
          node = object(target);
        }
        return node;
      }
      function textInput(raw: unknown): boolean {
        if (!raw || typeof raw !== "object") return false;
        const n = resolveRef(raw);
        const choices = n.oneOf ?? n.anyOf ?? n.allOf;
        if (Array.isArray(choices)) return choices.some(textInput);
        if (!n.properties) return false;
        const props = object(n.properties);
        if (!props.type || !props.text) return false;
        const tag = resolveRef(props.type);
        return (
          (tag.const === "text" || (Array.isArray(tag.enum) && tag.enum.includes("text"))) &&
          resolveRef(props.text).type === "string"
        );
      }
      function supportsSteer(raw: unknown) {
        if (!raw || typeof raw !== "object") return false;
        const params = resolveRef(raw);
        if (!params.properties) return false;
        const p = object(params.properties);
        return (
          !!p.threadId && !!p.expectedTurnId && !!p.input && textInput(resolveRef(p.input).items)
        );
      }
      function visit(raw: unknown) {
        if (!raw || typeof raw !== "object") return;
        if (Array.isArray(raw)) {
          raw.forEach(visit);
          return;
        }
        const node = object(raw);
        if (node.properties && typeof node.properties === "object") {
          const method = object(node.properties).method;
          if (method && typeof method === "object") {
            const values = object(method);
            const methods = Array.isArray(values.enum) ? values.enum : [values.const];
            for (const value of methods)
              if (
                typeof value === "string" &&
                (value !== "turn/steer" || supportsSteer(object(node.properties).params))
              )
                names.add(value);
          }
        }
        Object.values(node).forEach(visit);
      }
      visit(schema);
      return names;
    }
    const [requests, notices] = await Promise.all([
      methods("ClientRequest.json"),
      methods("ServerNotification.json"),
    ]);
    const basic =
      ["thread/start", "turn/start", "thread/read"].every((m) => requests.has(m)) &&
      [
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
      ].every((m) => notices.has(m));
    if (!basic) return false;
    const server = (await Bun.file(join(dir, "ServerRequest.json")).exists())
      ? await methods("ServerRequest.json")
      : new Set<string>();
    return { requests, server, notices };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function version(launch: Launch) {
  const p = Bun.spawn([launch.executable, "--version"], {
    cwd: launch.cwd,
    env: launch.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10000,
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  return code === 0 ? (/\b(\d+\.\d+\.\d+)\b/.exec(out)?.[1] ?? null) : null;
}
export function accountFingerprint(result: Record<string, unknown>) {
  return new Bun.CryptoHasher("sha256").update(canonicalJson(result.account)).digest("hex");
}
export async function probeCodex(
  reg: ExecutorRegistration,
  launch: Launch,
  previous?: CodexProbe,
): Promise<CodexProbe> {
  const unknown = { state: "unknown", verifiedAt: null } as const;
  const verified = (state: "yes" | "no" | "unknown") => ({ state, verifiedAt: Date.now() });
  const readiness: ExecutorRefreshed["readiness"] = {
    configured: verified(reg.enabled ? "yes" : "no"),
    installed: unknown,
    authenticated: unknown,
    model: unknown,
    operation: unknown,
  };
  let quotaAccount: string | null = null;
  let accountContext: string | null = null,
    nativeHome: string | null = null;
  let binaryVersion: string | null = null,
    models: Catalog | null = null,
    compatibilityAdvisory: CodexProbe["compatibilityAdvisory"] = null,
    versionAdvisory: string | null = null;
  let retryAt = Date.now() + 300000;
  let transient = false;
  const supported = new Set<CapabilityId>();
  const result = () => ({
    binaryVersion,
    accountContext,
    quotaAccount,
    nativeHome,
    historyRoot: reg.driver.historyRoot,
    models,
    compatibilityAdvisory,
    versionAdvisory,
    retryAt,
    transient,
    declaration: declaration(
      Number(reg.version),
      Date.now(),
      readiness,
      supported,
      reg.permission.selected,
    ),
  });
  if (!reg.enabled) return result();
  try {
    binaryVersion = await version(launch);
    if (binaryVersion && Bun.semver.order(binaryVersion, "0.149.0") < 0)
      binaryVersion = await version(launch);
    readiness.installed = verified("yes");
  } catch {
    readiness.installed = verified("no");
    return result();
  }
  if (binaryVersion && Bun.semver.order(binaryVersion, "0.159.0") < 0)
    versionAdvisory = "Recommended Codex version is 0.159.0 or newer";
  if (binaryVersion && Bun.semver.order(binaryVersion, "0.149.0") < 0) {
    compatibilityAdvisory = "broken";
    readiness.operation = verified("no");
    return result();
  }
  if (binaryVersion && Bun.semver.order(binaryVersion, "0.156.0") < 0)
    compatibilityAdvisory = "unsupported";
  let rpc: CodexConnection | undefined;
  try {
    rpc = new CodexConnection(launch);
    nativeHome = await rpc.initialize();
    supported.add("declareTransport");
    supported.add("negotiateProtocol");
    const a = object(await rpc.request("account/read", { refreshToken: false }));
    if (!Object.hasOwn(a, "account")) throw new Error("Missing Codex account");
    if (a.account !== null && typeof object(a.account).type !== "string")
      throw new Error("Invalid Codex account");
    accountContext = accountFingerprint(a);
    quotaAccount = verifiedQuotaAccount(a);
    readiness.authenticated = verified(
      a.account === null ? (a.requiresOpenaiAuth === false ? "yes" : "no") : "yes",
    );
    supported.add("checkAuthentication");
    if (readiness.authenticated.state !== "yes") return result();
    models = await listModels(rpc);
    supported.add("listModels");
    const model = selectedModel(models, reg.model);
    readiness.model = verified(model ? "yes" : "no");
    if (!model) return result();
    await openThread(rpc, launch.cwd, model, true, reg.permission.selected);
    const methods = await basicMethods(launch);
    if (!methods) {
      readiness.operation = verified("no");
      return result();
    }
    readiness.operation = verified("yes");
    for (const id of basic) supported.add(id);
    supported.add("readHistory");
    if (quotaAccount && methods.requests.has("account/rateLimits/read"))
      supported.add("reportQuota");
    if (quotaAccount && methods.requests.has("account/usage/read")) supported.add("reportCost");
    if (methods.notices.has("thread/tokenUsage/updated")) supported.add("reportTokenUsage");
    if (methods.requests.has("thread/resume")) {
      supported.add("resumeSessionAfterProcessExit");
      supported.add("resumeSessionAfterHostRestart");
    }
    if (methods.requests.has("turn/interrupt")) supported.add("stopRound");
    if (methods.requests.has("turn/steer")) supported.add("steerCurrentRound");
    for (const [method, id] of [
      ["item/commandExecution/requestApproval", "requestCommandApproval"],
      ["item/fileChange/requestApproval", "requestFileApproval"],
      ["item/tool/requestUserInput", "askStructuredQuestion"],
    ] as const)
      if (methods.server.has(method)) {
        supported.add(id);
        supported.add("answerApprovalChoices");
      }
  } catch (error) {
    if (!models && error instanceof NativeError && error.reason === "notAuthenticated") {
      readiness.authenticated = verified("no");
      models = null;
    } else if (
      !models &&
      previous?.models &&
      !previous.transient &&
      previous.declaration.readiness.authenticated.state === "yes"
    ) {
      transient = true;
      models = previous.models;
      readiness.model = { state: "unknown", verifiedAt: models.checkedAt };
      retryAt = Date.now() + 30000;
    }
    if (rpc && readiness.operation.verifiedAt === null) readiness.operation = verified("unknown");
  } finally {
    await rpc?.close();
  }
  return result();
}
