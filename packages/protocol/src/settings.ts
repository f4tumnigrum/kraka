import { ModelRatesSchema } from "./account-usage";
import { canonicalJson } from "./canonical-json";
import * as v from "valibot";
import {
  DeviceIdSchema,
  EnvironmentIdSchema,
  ObjectVersionSchema,
  ProjectIdSchema,
  WorktreeIdSchema,
  WorktreeGenerationSchema,
} from "./ids";

const environment = v.strictObject({
  kind: v.literal("environment"),
  environmentId: EnvironmentIdSchema,
});
const project = v.strictObject({
  ...environment.entries,
  kind: v.literal("project"),
  projectId: ProjectIdSchema,
});
const checkout = v.strictObject({
  ...project.entries,
  kind: v.literal("checkout"),
  worktreeId: WorktreeIdSchema,
});
export const SettingCheckoutSchema = checkout;
const device = v.strictObject({ kind: v.literal("device"), deviceId: DeviceIdSchema });
const builtin = v.strictObject({ kind: v.literal("builtin") });
const policy = { environmentId: EnvironmentIdSchema, policyId: v.pipe(v.string(), v.minLength(1)) };
const lock = v.strictObject({ kind: v.literal("lock"), ...policy });
const organizationDefault = v.strictObject({ kind: v.literal("organizationDefault"), ...policy });
const repository = v.strictObject({
  ...checkout.entries,
  kind: v.literal("repository"),
  path: v.pipe(v.string(), v.minLength(1)),
  generation: v.optional(WorktreeGenerationSchema),
});
export const RemoteSettingTargetSchema = v.variant("kind", [environment, project, checkout]);
export type RemoteSettingTarget = v.InferOutput<typeof RemoteSettingTargetSchema>;
export const SettingSourceSchema = v.variant("kind", [
  environment,
  project,
  checkout,
  repository,
  organizationDefault,
  lock,
  builtin,
  device,
]);
export type SettingSource = v.InferOutput<typeof SettingSourceSchema>;
type TargetSchema = typeof environment | typeof project | typeof checkout;
const absent = v.strictObject({ kind: v.literal("absent") });
// The host separately verifies the physical directory and write access.
const worktreeAbsolutePath = v.pipe(
  v.string(),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Filesystem paths cannot contain NUL.
  v.regex(/^(?![\s\S]*\x00)(?:\/|[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/),
);
export const WorktreeLocationSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("default") }),
  v.strictObject({ kind: v.literal("custom"), path: worktreeAbsolutePath }),
]);
// The final component gains a UUID suffix. Other components must already be valid ref components.
const branchPrefix = v.pipe(
  v.string(),
  v.minLength(1),
  // biome-ignore lint/suspicious/noControlCharactersInRegex: Git excludes ASCII controls from refs.
  v.regex(/^(?![-./])(?!.*(?:\/\.|\/\/|\.\.|@\{|\.lock\/))(?!.*[-\/]$)[^\x00-\x20\x7f~^:?*\[\\]+$/),
);
export const WorktreeBranchNamingSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("generated") }),
  v.strictObject({ kind: v.literal("fixedPrefix"), prefix: branchPrefix }),
]);
export const WorktreeSubmodulesSchema = v.picklist(["none", "topLevel", "recursive"]);
export type WorktreeLocation = v.InferOutput<typeof WorktreeLocationSchema>;
export type WorktreeBranchNaming = v.InferOutput<typeof WorktreeBranchNamingSchema>;
export type WorktreeSubmodules = v.InferOutput<typeof WorktreeSubmodulesSchema>;

function field<const K extends string, S extends v.GenericSchema>(
  name: K,
  value: S,
  fallback: NoInfer<v.InferOutput<S>>,
) {
  const explicit = v.variant("kind", [absent, v.strictObject({ kind: v.literal("set"), value })]);
  return { name, value, fallback, explicit };
}

function remoteField<
  const K extends string,
  S extends v.GenericSchema,
  const T extends readonly TargetSchema[],
>(
  name: K,
  value: S,
  fallback: NoInfer<v.InferOutput<S>>,
  targets: T,
  options: { repository: boolean; lockable: boolean; organizationDefault?: false },
) {
  const definition = field(name, value, fallback);
  const target = v.union(targets);
  const address = { field: v.literal(name), target, checkout: v.nullable(checkout) };
  const read = v.pipe(
    v.strictObject(address),
    v.description(
      `Built-in value ${JSON.stringify(fallback)}. Writable at ${targets.map((item) => item.entries.kind.literal).join(", ")}. Repository declarations: ${options.repository}. Administrator lock: ${options.lockable}.`,
    ),
  );
  const edit = v.strictObject({
    ...address,
    baseVersion: ObjectVersionSchema,
    change: definition.explicit,
  });
  const row = v.strictObject({
    field: address.field,
    target,
    version: ObjectVersionSchema,
    explicit: definition.explicit,
  });
  const overlaySources = [
    ...(options.organizationDefault === false ? [] : [organizationDefault]),
    ...(options.repository ? [repository] : []),
    ...(options.lockable ? [lock] : []),
  ];
  const overlay = v.strictObject({
    field: address.field,
    source: overlaySources.length ? v.union(overlaySources) : v.never(),
    version: ObjectVersionSchema,
    value,
  });
  const effective = v.union([
    v.strictObject({ value, source: builtin, sourceVersion: v.null_() }),
    v.strictObject({
      value,
      source: v.union([...targets, ...overlaySources]),
      sourceVersion: ObjectVersionSchema,
    }),
  ]);
  const readback = v.strictObject({
    ...address,
    atLayer: definition.explicit,
    fieldVersion: ObjectVersionSchema,
    effective,
    readVersion: ObjectVersionSchema,
  });
  return { ...definition, ...options, targets, read, edit, row, overlay, readback };
}

function deviceField<const K extends string, S extends v.GenericSchema>(
  name: K,
  value: S,
  fallback: NoInfer<v.InferOutput<S>>,
) {
  const definition = field(name, value, fallback);
  const row = v.strictObject({
    field: v.literal(name),
    target: device,
    version: ObjectVersionSchema,
    explicit: definition.explicit,
  });
  const edit = v.strictObject({
    field: v.literal(name),
    target: device,
    baseVersion: ObjectVersionSchema,
    change: definition.explicit,
  });
  return { ...definition, targets: [device] as const, lockable: false as const, row, edit };
}
export const deviceSettings = [
  deviceField("fontSize", v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(256)), 16),
] as const;

/** Each entry defines both the writable locations and the read-only inputs for one field. */
export const remoteSettings = [
  remoteField("modelRates", ModelRatesSchema, { kind: "modelRates", models: {} }, [environment], {
    repository: false,
    lockable: false,
    organizationDefault: false,
  }),
  remoteField(
    "directoryMode",
    v.picklist(["local", "worktree"]),
    "local",
    [environment, project, checkout],
    { repository: true, lockable: true },
  ),
  remoteField(
    "defaultModel",
    v.nullable(v.pipe(v.string(), v.minLength(1))),
    null,
    [environment, project, checkout],
    { repository: false, lockable: true },
  ),
  remoteField("worktreeLocation", WorktreeLocationSchema, { kind: "default" }, [environment], {
    repository: false,
    lockable: false,
    organizationDefault: false,
  }),
  remoteField(
    "worktreeBranchNaming",
    WorktreeBranchNamingSchema,
    { kind: "generated" },
    [environment, project, checkout],
    { repository: false, lockable: false, organizationDefault: false },
  ),
  remoteField(
    "worktreeSubmodules",
    WorktreeSubmodulesSchema,
    "recursive",
    [environment, project, checkout],
    { repository: true, lockable: false, organizationDefault: false },
  ),
] as const;

export const DeviceSettingRowSchema = v.variant(
  "field",
  deviceSettings.map((d) => d.row),
);
export const DeviceSettingWriteSchema = v.variant(
  "field",
  deviceSettings.map((d) => d.edit),
);
export type DeviceSettingWrite = v.InferOutput<typeof DeviceSettingWriteSchema>;
export type DeviceSettingRow = v.InferOutput<typeof DeviceSettingRowSchema>;
export const SettingReadSchema = v.variant(
  "field",
  remoteSettings.map((d) => d.read),
);
export const SettingWriteSchema = v.variant(
  "field",
  remoteSettings.map((d) => d.edit),
);
export const SettingRowSchema = v.variant(
  "field",
  remoteSettings.map((d) => d.row),
);
export const SettingOverlaySchema = v.variant(
  "field",
  remoteSettings.map((d) => d.overlay),
);
export const SettingReadbackSchema = v.variant(
  "field",
  remoteSettings.map((d) => d.readback),
);
export type SettingRead = v.InferOutput<typeof SettingReadSchema>;
export type SettingWrite = v.InferOutput<typeof SettingWriteSchema>;
export type SettingRow = v.InferOutput<typeof SettingRowSchema>;
export type SettingOverlay = v.InferOutput<typeof SettingOverlaySchema>;
export type SettingReadback = v.InferOutput<typeof SettingReadbackSchema>;
export type EffectiveSetting = SettingReadback["effective"];
export type SettingField = SettingRow["field"] | DeviceSettingRow["field"];
export type SettingValue<K extends SettingField> = Extract<
  Extract<SettingRow | DeviceSettingRow, { field: K }>["explicit"],
  { kind: "set" }
>["value"];

// A newer peer may advertise names outside this reader's catalog.
const supportedFields = v.array(v.pipe(v.string(), v.minLength(1)));
export const SettingReadResultSchema = v.strictObject({
  kind: v.literal("settingRead"),
  readback: SettingReadbackSchema,
});
export const SettingSavedSchema = v.strictObject({
  kind: v.literal("settingSaved"),
  supportedFields,
  readback: SettingReadbackSchema,
});
export const SettingWriteFailureSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("settingLocked"),
    request: SettingReadSchema,
    supportedFields,
    lockedBy: lock,
  }),
  v.strictObject({
    kind: v.literal("settingVersionConflict"),
    supportedFields,
    readback: SettingReadbackSchema,
  }),
  v.strictObject({
    kind: v.literal("unrecognizedSetting"),
    field: v.string(),
    target: RemoteSettingTargetSchema,
    checkout: v.nullable(checkout),
    supportedFields,
  }),
]);

/** Signed settings and their readbacks can be decoded in different processes. */
export function sameSettingChoice(
  left: SettingWrite["change"],
  right: SettingWrite["change"],
): boolean {
  if (left.kind === "absent" || right.kind === "absent") return left.kind === right.kind;
  const a = left.value,
    b = right.value;
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  switch (a.kind) {
    case "modelRates":
      return b.kind === "modelRates" && canonicalJson(a) === canonicalJson(b);
    case "default":
    case "generated":
      return a.kind === b.kind;
    case "custom":
      return b.kind === "custom" && a.path === b.path;
    case "fixedPrefix":
      return b.kind === "fixedPrefix" && a.prefix === b.prefix;
  }
}

export function sameSettingTarget(a: RemoteSettingTarget, b: RemoteSettingTarget): boolean {
  if (a.environmentId !== b.environmentId || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "environment":
      return true;
    case "project":
      return b.kind === "project" && a.projectId === b.projectId;
    case "checkout":
      return b.kind === "checkout" && a.projectId === b.projectId && a.worktreeId === b.worktreeId;
  }
}

export const settingSchemas = {
  WorktreeLocation: WorktreeLocationSchema,
  WorktreeBranchNaming: WorktreeBranchNamingSchema,
  WorktreeSubmodules: WorktreeSubmodulesSchema,
  DeviceSettingRow: DeviceSettingRowSchema,
  DeviceSettingWrite: DeviceSettingWriteSchema,
  RemoteSettingTarget: RemoteSettingTargetSchema,
  SettingSource: SettingSourceSchema,
  SettingRead: SettingReadSchema,
  SettingWrite: SettingWriteSchema,
  SettingRow: SettingRowSchema,
  SettingOverlay: SettingOverlaySchema,
  SettingReadback: SettingReadbackSchema,
  SettingSaved: SettingSavedSchema,
  SettingWriteFailure: SettingWriteFailureSchema,
};
