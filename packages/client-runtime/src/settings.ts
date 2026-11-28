import {
  readSettingWriteReceipt,
  sameSettingTarget,
  sameSettingChoice,
  deviceSettings,
  type CommandId,
  type CommandReceipt,
  type DeviceSettingRow,
  type DeviceSettingWrite,
  type EnvironmentId,
  type SettingRead,
  type SettingReadback,
  type SettingSource,
  type SettingWrite,
} from "@kraka/protocol";

/** Device preferences use their local field version. They are never input to checkout resolution. */
export function readDeviceSetting(row: DeviceSettingRow) {
  const definition = deviceSettings.find((d) => d.name === row.field);
  if (!definition) throw new Error("Missing device setting definition");
  const value = row.explicit.kind === "set" ? row.explicit.value : definition.fallback;
  const source = row.explicit.kind === "set" ? row.target : { kind: "builtin" as const };
  const sourceVersion = row.explicit.kind === "set" ? row.version : null;
  return {
    field: row.field,
    target: row.target,
    atLayer: row.explicit,
    fieldVersion: row.version,
    readVersion: row.version,
    effective: { value, source, sourceVersion },
    value,
    source,
    version: row.version,
  };
}

/** The device store retains reset versions, including when the field has no explicit choice. */
export interface DeviceSettingsStore {
  read(field: DeviceSettingRow["field"]): Promise<DeviceSettingRow>;
  write(
    commandId: CommandId,
    edit: DeviceSettingWrite,
  ): Promise<{ kind: "saved" | "conflict"; row: DeviceSettingRow }>;
}

export type SettingWriteOutcome =
  | { kind: "saved"; readback: SettingReadback }
  | { kind: "locked"; lockedBy: Extract<SettingSource, { kind: "lock" }> }
  | { kind: "unrecognized"; supportedFields: readonly string[] }
  | { kind: "offline" };
export type SettingWriteMember = { commandId: CommandId; edit: SettingWrite } & (
  | { kind: "prepared" | "checking" }
  | { kind: "finished"; outcome: SettingWriteOutcome }
  | { kind: "failed"; receipt: Exclude<CommandReceipt, { kind: "accepted" }> }
);
export type SettingWriteBatch = ReadonlyMap<EnvironmentId, readonly SettingWriteMember[]>;
/** Freeze every selected member, including disconnected environments, before dispatch starts. */
export function prepareSettingWrites(
  writes: readonly { commandId: CommandId; edit: SettingWrite }[],
): SettingWriteBatch {
  const batch = new Map<EnvironmentId, SettingWriteMember[]>();
  for (const write of writes) {
    const env = write.edit.target.environmentId;
    const members = batch.get(env) ?? [];
    if (members.some((m) => m.commandId === write.commandId))
      throw new Error("Duplicate setting command in an environment");
    members.push({ ...write, kind: "prepared" });
    batch.set(env, members);
  }
  return batch;
}
export type SettingWriteObservation =
  | { kind: "offlineBeforeSend" | "sending" }
  | { kind: "reply"; environmentId: EnvironmentId; receipt: unknown };

export function matchesSettingRead(
  request: SettingRead,
  readback: Omit<SettingRead, "field"> & { field: string },
) {
  return (
    request.field === readback.field &&
    sameSettingTarget(request.target, readback.target) &&
    (request.checkout === null
      ? readback.checkout === null
      : readback.checkout !== null && sameSettingTarget(request.checkout, readback.checkout))
  );
}

/** Persist checking before sending. An interrupted send stays checking against the original command ID. */
export function advanceSettingWrite(
  member: SettingWriteMember,
  event: SettingWriteObservation,
): SettingWriteMember {
  if (member.kind === "finished" || member.kind === "failed") return member;
  if (event.kind === "offlineBeforeSend")
    return member.kind === "prepared"
      ? { ...member, kind: "finished", outcome: { kind: "offline" } }
      : member;
  if (event.kind === "sending") return { ...member, kind: "checking" };
  if (
    event.kind !== "reply" ||
    member.kind !== "checking" ||
    event.environmentId !== member.edit.target.environmentId
  )
    return member;
  const finish = (outcome: SettingWriteOutcome): SettingWriteMember => ({
    ...member,
    kind: "finished",
    outcome,
  });
  const receipt = readSettingWriteReceipt(event.receipt);
  if (!receipt || receipt.commandId !== member.commandId) return member;
  if (receipt.kind === "programError") return { ...member, kind: "failed", receipt };
  if (receipt.kind === "rejected") {
    const f = receipt.failure;
    if (f.kind === "settingVersionConflict" && !matchesSettingRead(member.edit, f.readback))
      return member;
    if (f.kind === "settingLocked")
      return matchesSettingRead(member.edit, f.request) &&
        f.lockedBy.environmentId === event.environmentId
        ? finish({ kind: "locked", lockedBy: f.lockedBy })
        : member;
    if (f.kind === "unrecognizedSetting")
      return matchesSettingRead(member.edit, f) && !f.supportedFields.includes(member.edit.field)
        ? finish({ kind: "unrecognized", supportedFields: f.supportedFields })
        : member;
    return { ...member, kind: "failed", receipt };
  }
  const result = receipt.result;
  if (result.kind === "actionAccepted") {
    const fields = result.supportedFields;
    return fields && !fields.includes(member.edit.field)
      ? finish({ kind: "unrecognized", supportedFields: fields })
      : member;
  }
  if (result.kind !== "settingSaved" || !matchesSettingRead(member.edit, result.readback))
    return member;
  if (!result.supportedFields.includes(member.edit.field))
    return finish({ kind: "unrecognized", supportedFields: result.supportedFields });
  if (
    BigInt(result.readback.fieldVersion) > BigInt(result.readback.readVersion) ||
    BigInt(result.readback.fieldVersion) < BigInt(member.edit.baseVersion) ||
    (result.readback.atLayer.kind === "set" && result.readback.fieldVersion === "0")
  )
    return member;
  return sameSettingChoice(result.readback.atLayer, member.edit.change)
    ? finish({ kind: "saved", readback: result.readback })
    : member;
}
