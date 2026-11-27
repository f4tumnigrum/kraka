import * as v from "valibot";
import {
  ObjectVersionSchema,
  SettingRowSchema,
  SettingReadbackSchema,
  SettingReadSchema,
  remoteSettings,
  sameSettingTarget,
  sameSettingChoice,
  type CommandId,
  type CommandReceipt,
  type EnvironmentId,
  type ObjectVersion,
  type Project,
  type Worktree,
  type RemoteSettingTarget,
  type SettingOverlay,
  type SettingRead,
  type SettingReadback,
  type SettingRow,
  type SettingWrite,
} from "@kraka/protocol";

/** One committed view. Each (target, field) has at most one current row, including a reset tombstone. */
export interface SettingsSnapshot {
  environmentId: EnvironmentId;
  version: ObjectVersion;
  projects: readonly Pick<Project, "id" | "environmentId">[];
  worktrees: readonly Pick<Worktree, "id" | "projectId">[];
  rows: readonly SettingRow[];
  overlays: readonly SettingOverlay[];
}

const initialVersion = v.parse(ObjectVersionSchema, "0");
const nextVersion = (version: ObjectVersion) =>
  v.parse(ObjectVersionSchema, (BigInt(version) + 1n).toString());

function contains(parent: RemoteSettingTarget, child: RemoteSettingTarget): boolean {
  return (
    parent.environmentId === child.environmentId &&
    (parent.kind === "environment" ||
      (parent.kind === "project" &&
        child.kind !== "environment" &&
        parent.projectId === child.projectId) ||
      sameSettingTarget(parent, child))
  );
}
function exists(snapshot: SettingsSnapshot, target: RemoteSettingTarget) {
  if (target.environmentId !== snapshot.environmentId) return false;
  if (target.kind === "environment") return true;
  return (
    snapshot.projects.some(
      (p) => p.environmentId === target.environmentId && p.id === target.projectId,
    ) &&
    (target.kind === "project" ||
      snapshot.worktrees.some(
        (w) => w.id === target.worktreeId && w.projectId === target.projectId,
      ))
  );
}

const precedence = {
  lock: 0,
  checkout: 1,
  project: 2,
  environment: 3,
  repository: 4,
  organizationDefault: 5,
  builtin: 6,
} as const satisfies Record<
  Exclude<SettingReadback["effective"]["source"]["kind"], "device">,
  number
>;

/** Resolve at a single environment version. A stored default and an absent row have distinct provenance. */
export function readSetting(
  snapshot: SettingsSnapshot,
  query: SettingRead,
): SettingReadback | null {
  const context = query.checkout ?? query.target;
  if (!contains(query.target, context) || !exists(snapshot, context)) return null;
  const definition = remoteSettings.find((d) => d.name === query.field);
  if (!definition) throw new Error("Missing setting definition");
  type Choice = SettingReadback["effective"];
  let selected: {
    source: Choice["source"];
    value: Choice["value"];
    sourceVersion: ObjectVersion | null;
  } = { source: { kind: "builtin" }, value: definition.fallback, sourceVersion: null };
  function consider(choice: typeof selected) {
    if (precedence[choice.source.kind] < precedence[selected.source.kind]) selected = choice;
  }
  let explicit: SettingReadback["atLayer"] = { kind: "absent" };
  let fieldVersion = initialVersion;
  for (const row of snapshot.rows) {
    if (row.field !== query.field || !contains(row.target, context)) continue;
    if (sameSettingTarget(row.target, query.target)) {
      explicit = row.explicit;
      fieldVersion = row.version;
    }
    if (row.explicit.kind === "set")
      consider({ source: row.target, value: row.explicit.value, sourceVersion: row.version });
  }
  for (const overlay of snapshot.overlays) {
    const source = overlay.source;
    if (overlay.field !== query.field || source.environmentId !== context.environmentId) continue;
    if (
      source.kind === "repository" &&
      (!definition.repository ||
        context.kind !== "checkout" ||
        source.projectId !== context.projectId ||
        source.worktreeId !== context.worktreeId)
    )
      continue;
    if (source.kind === "lock" && !definition.lockable) continue;
    consider({ source, value: overlay.value, sourceVersion: overlay.version });
  }
  return v.parse(SettingReadbackSchema, {
    field: query.field,
    target: query.target,
    checkout: query.checkout,
    atLayer: explicit,
    fieldVersion,
    effective: selected,
    readVersion: snapshot.version,
  });
}

/** The authorized command owner commits this snapshot and receipt together, and reuses the receipt on retry. */
export function applySettingWrite(
  snapshot: SettingsSnapshot,
  commandId: CommandId,
  edit: SettingWrite,
): { snapshot: SettingsSnapshot; receipt: CommandReceipt } {
  const request = v.parse(SettingReadSchema, {
    field: edit.field,
    target: edit.target,
    checkout: edit.checkout,
  });
  const before = readSetting(snapshot, request);
  const supportedFields = remoteSettings.map((d) => d.name);
  if (!before)
    return {
      snapshot,
      receipt: { kind: "rejected", commandId, failure: { kind: "invalidState" } },
    };
  if (before.effective.source.kind === "lock")
    return {
      snapshot,
      receipt: {
        kind: "rejected",
        commandId,
        failure: {
          kind: "settingLocked",
          request,
          supportedFields,
          lockedBy: before.effective.source,
        },
      },
    };
  const change = edit.change;
  if (sameSettingChoice(change, before.atLayer))
    return {
      snapshot,
      receipt: {
        kind: "accepted",
        commandId,
        result: { kind: "settingSaved", supportedFields, readback: before },
      },
    };
  if (edit.baseVersion !== before.fieldVersion)
    return {
      snapshot,
      receipt: {
        kind: "rejected",
        commandId,
        failure: { kind: "settingVersionConflict", supportedFields, readback: before },
      },
    };
  const row = v.parse(SettingRowSchema, {
    field: edit.field,
    target: edit.target,
    version: nextVersion(before.fieldVersion),
    explicit: change,
  });
  const next = {
    ...snapshot,
    version: nextVersion(snapshot.version),
    rows: [
      ...snapshot.rows.filter(
        (r) => r.field !== edit.field || !sameSettingTarget(r.target, edit.target),
      ),
      row,
    ],
  };
  const readback = readSetting(next, request);
  if (!readback) throw new Error("Committed setting lost its read context");
  return {
    snapshot: next,
    receipt: {
      kind: "accepted",
      commandId,
      result: { kind: "settingSaved", supportedFields, readback },
    },
  };
}
