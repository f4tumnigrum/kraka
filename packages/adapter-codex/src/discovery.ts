import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CapabilityMatrixSchema,
  NativeSessionIdSchema,
  type CapabilityId,
  type ExecutorRefreshed,
} from "@kraka/protocol";
import type { CapabilityDeclaration, ExecutorRegistration, SessionSetup } from "@kraka/environment";
import { CodexConnection, type Launch } from "./stdio";
import { NativeError, object } from "./native";

type Catalog = NonNullable<ExecutorRefreshed["models"]>;
export type CodexProbe = {
  declaration: CapabilityDeclaration<"codex">;
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
    steering: { queueNext: steer, insertCurrent: steer, restartCurrent: steer },
    requests: { approval: request, question: request },
    permission: {
      modes: supported.has("selectPermissionMode") ? ["ask"] : [],
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
) {
  const { effort, serviceTier } = model.options;
  const r = object(
    await rpc.request("thread/start", {
      cwd,
      model: model.id,
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandbox: "read-only",
      ...(effort ? { config: { model_reasoning_effort: effort } } : {}),
      ...(serviceTier ? { serviceTier } : {}),
      ...(probe ? { ephemeral: true } : {}),
    }),
  );
  const thread = object(r.thread),
    sandbox = object(r.sandbox);
  if (
    r.cwd !== cwd ||
    r.model !== model.id ||
    r.approvalPolicy !== "untrusted" ||
    r.approvalsReviewer !== "user" ||
    sandbox.type !== "readOnly" ||
    sandbox.networkAccess !== false ||
    (thread.cwd !== undefined && thread.cwd !== cwd) ||
    (thread.model != null && thread.model !== model.id) ||
    (effort !== undefined && r.reasoningEffort !== effort) ||
    (serviceTier !== undefined && r.serviceTier !== serviceTier)
  )
    throw new NativeError("unsupported", "Codex returned incompatible effective session settings");
  return v.parse(NativeSessionIdSchema, thread.id);
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
            if (typeof values.const === "string") names.add(values.const);
            if (Array.isArray(values.enum))
              for (const value of values.enum) if (typeof value === "string") names.add(value);
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
    return (
      ["thread/start", "turn/start", "thread/read"].every((m) => requests.has(m)) &&
      [
        "turn/started",
        "turn/completed",
        "item/started",
        "item/completed",
        "item/agentMessage/delta",
        "item/commandExecution/outputDelta",
      ].every((m) => notices.has(m))
    );
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
  let binaryVersion: string | null = null,
    models: Catalog | null = null,
    compatibilityAdvisory: CodexProbe["compatibilityAdvisory"] = null,
    versionAdvisory: string | null = null;
  let retryAt = Date.now() + 300000;
  let transient = false;
  const supported = new Set<CapabilityId>();
  const result = () => ({
    binaryVersion,
    models,
    compatibilityAdvisory,
    versionAdvisory,
    retryAt,
    transient,
    declaration: declaration(Number(reg.version), Date.now(), readiness, supported),
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
    await rpc.initialize();
    supported.add("declareTransport");
    supported.add("negotiateProtocol");
    const a = object(await rpc.request("account/read", { refreshToken: false }));
    if (!Object.hasOwn(a, "account")) throw new Error("Missing Codex account");
    if (a.account !== null && typeof object(a.account).type !== "string")
      throw new Error("Invalid Codex account");
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
    await openThread(rpc, launch.cwd, model, true);
    if (!(await basicMethods(launch))) {
      readiness.operation = verified("no");
      return result();
    }
    readiness.operation = verified("yes");
    for (const id of basic) supported.add(id);
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
