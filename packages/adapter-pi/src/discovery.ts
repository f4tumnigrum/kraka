import * as v from "valibot";
import {
  CAPABILITY_IDS,
  CapabilityMatrixSchema,
  type CapabilityId,
  type ExecutorRefreshed,
  type InstancePermission,
} from "@kraka/protocol";
import type { CapabilityDeclaration, Readiness } from "@kraka/environment";
import { modelsSchema } from "./native";
import { openPiProcess, piEnvironment, type PiLaunch } from "./launch";

type Catalog = NonNullable<ExecutorRefreshed["models"]>;
export type PiProbe = {
  binaryVersion: string | null;
  compatibilityAdvisory: ExecutorRefreshed["compatibilityAdvisory"];
  models: Catalog | null;
  declaration: CapabilityDeclaration<"pi">;
};
async function cli(launch: PiLaunch, args: string[]) {
  const child = Bun.spawn([launch.executable, ...args], {
    cwd: launch.cwd,
    env: piEnvironment(launch),
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
    timeout: 10_000,
  });
  const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return { code, output };
}
export async function checkPiAccount(launch: PiLaunch, model: string): Promise<Readiness> {
  const provider = model.split("/")[0];
  if (!provider) return { state: "unknown", verifiedAt: null };
  const { code } = await cli(launch, [
    "auth",
    "check",
    "--provider",
    provider,
    "--json",
    "--no-refresh",
  ]);
  return { state: code === 0 ? "yes" : code === 1 ? "no" : "unknown", verifiedAt: Date.now() };
}
const native: readonly CapabilityId[] = [
  "startSession",
  "resumeSessionAfterProcessExit",
  "submitTextInput",
  "streamResponse",
  "exposeReasoning",
  "reportToolActivity",
  "reportRoundEnd",
  "stopRound",
  "askStructuredQuestion",
  "isolateAccounts",
  "listModels",
  "checkAuthentication",
  "declareTransport",
  "configureWorkspace",
  "configureEnvironment",
];
const policy: readonly CapabilityId[] = [
  "answerApprovalChoices",
  "selectPermissionMode",
  "requestFileApproval",
  "requestCommandApproval",
];
export async function probePi(
  launch: PiLaunch,
  permission: InstancePermission,
  selectedModel: string | null = null,
  previous?: PiProbe,
): Promise<PiProbe> {
  const unknown = { state: "unknown", verifiedAt: null } as const;
  const dated = (state: Readiness["state"]): Readiness => ({ state, verifiedAt: Date.now() });
  const readiness: ExecutorRefreshed["readiness"] = {
    configured: dated("yes"),
    installed: unknown,
    authenticated: unknown,
    model: unknown,
    operation: unknown,
  };
  let binaryVersion: string | null = null;
  let compatibilityAdvisory: PiProbe["compatibilityAdvisory"] = null;
  let models: Catalog | null = null;
  try {
    const version = await cli(launch, ["--version"]);
    readiness.installed = dated(version.code === 0 ? "yes" : "no");
    const match = version.output.trim().match(/^(?:pi\s+)?(\d+\.\d+\.\d+)$/i);
    binaryVersion = match?.[1] ?? null;
    if (!binaryVersion || Bun.semver.order(binaryVersion, "0.84.3") < 0 || version.code !== 0)
      compatibilityAdvisory = "unsupported";
    else {
      const peer = await openPiProcess(launch, 1, permission.selected, { kind: "probe" });
      try {
        const data = v.parse(modelsSchema, await peer.rpc.request("get_available_models"));
        const current = peer.state.model;
        models = {
          checkedAt: Date.now(),
          models: data.models.map((m) => ({
            id: `${m.provider}/${m.id}`,
            slug: m.id,
            displayName: m.name,
            isDefault: m.id === current?.id && m.provider === current.provider,
            options: {},
          })),
        };
        const model = selectedModel ?? (current ? `${current.provider}/${current.id}` : null);
        readiness.model = dated(models.models.some((m) => m.id === model) ? "yes" : "no");
        readiness.operation = dated("yes");
        if (model) readiness.authenticated = await checkPiAccount(launch, model);
      } finally {
        await peer.close();
      }
    }
  } catch {
    if (readiness.installed.state === "unknown") readiness.installed = dated("no");
    else if (readiness.operation.state !== "yes") {
      readiness.operation = dated("no");
      compatibilityAdvisory = "broken";
    }
  }
  const unavailable = {
    kind: "unsupported",
    reason: "Unavailable on this Pi RPC entry point",
  } as const;
  const verified = readiness.operation.state === "yes";
  const matrix = v.parse(
    CapabilityMatrixSchema,
    Object.fromEntries(
      CAPABILITY_IDS.map((id) => [
        id,
        !verified
          ? unavailable
          : native.includes(id)
            ? { kind: "native" }
            : policy.includes(id)
              ? { kind: "substitute", reason: "Verified Kraka Pi tool policy" }
              : unavailable,
      ]),
    ),
  );
  const modes = verified
    ? ["ask", "edits", "open"].slice(0, ["ask", "edits", "open"].indexOf(permission.ceiling) + 1)
    : [];
  const none = { receipt: "none", deduplicate: "none", query: "none" } as const;
  const steer = { support: unavailable, readReceipt: "no", accepts: [] } as const;
  const declaration: CapabilityDeclaration<"pi"> = {
    family: "pi",
    version: previous?.declaration.version ?? 1,
    checkedAt: Date.now(),
    matrix,
    readiness,
    input: none,
    answer: none,
    steering: { queueNext: steer, insertCurrent: steer, restartCurrent: steer },
    requests: {
      question: { afterSessionLoss: "liveOnly" },
      approval: { afterSessionLoss: "liveOnly" },
    },
    permission: {
      enforcement: verified ? "adapter" : "unknown",
      changeEffective: "restart",
      modes,
    },
    endReasons: ["completed", "stopped", "failed", "unknown"],
    childWork: "unsupported",
  };
  if (
    previous &&
    (!Bun.deepEquals(previous.declaration.matrix, matrix) ||
      !Bun.deepEquals(previous.declaration.permission, declaration.permission) ||
      binaryVersion !== previous.binaryVersion ||
      !Bun.deepEquals(models?.models, previous.models?.models) ||
      Object.entries(readiness).some(
        ([k, val]) =>
          previous.declaration.readiness[k as keyof typeof readiness].state !== val.state,
      ))
  )
    declaration.version++;
  return { binaryVersion, compatibilityAdvisory, models, declaration };
}
