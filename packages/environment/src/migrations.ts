import * as v from "valibot";
import {
  ReleaseVersionSchema,
  type ActiveReleasePointer,
  type UpgradeView,
  EnvironmentIdSchema,
  HostInstanceIdSchema,
  CommandIdSchema,
  type CommandId,
  type HostInstanceId,
  type EnvironmentId,
} from "@kraka/protocol";

const text = v.pipe(v.string(), v.minLength(1));
const ordinal = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
export const MigrationIdSchema = v.pipe(text, v.brand("MigrationId"));
export const MigrationSchema = v.strictObject({
  id: MigrationIdSchema,
  from: ordinal,
  to: ordinal,
});
export type Migration = v.InferOutput<typeof MigrationSchema>;
export const MigrationCatalogSchema = v.strictObject({
  initial: ordinal,
  steps: v.array(MigrationSchema),
});
export type MigrationCatalog = v.InferOutput<typeof MigrationCatalogSchema>;
/** A ledger entry and its new format marker commit in the same transaction as the changed current rows. */
export const DatabaseHeaderSchema = v.strictObject({
  format: ordinal,
  ledger: v.array(MigrationSchema),
});
export type DatabaseHeader = v.InferOutput<typeof DatabaseHeaderSchema>;
export const ReleaseSchema = v.strictObject({
  version: ReleaseVersionSchema,
  digest: v.pipe(text, v.regex(/^[0-9a-f]{64}$/)),
  catalog: MigrationCatalogSchema,
});
export type Release = v.InferOutput<typeof ReleaseSchema>;
export {
  ActiveReleasePointerSchema,
  releaseDirectory,
  type ActiveReleasePointer,
} from "@kraka/protocol";
function sameStep(a: Migration, b: Migration) {
  return a.id === b.id && a.from === b.from && a.to === b.to;
}
function validCatalog(catalog: MigrationCatalog) {
  const ids = new Set<Migration["id"]>();
  let from = catalog.initial;
  for (const step of catalog.steps) {
    if (ids.has(step.id) || step.from !== from || step.to <= step.from) return false;
    ids.add(step.id);
    from = step.to;
  }
  return true;
}
export type DatabaseCompatibility =
  | { kind: "open" }
  | { kind: "migrationRequired"; next: Migration }
  | {
      kind: "refuse";
      reason: "futureFormat" | "unknownMigration" | "invalidLedger" | "invalidCatalog";
    };
/** A read-only probe of metadata, before opening application tables, switching journaling mode or taking a migration action. */
export function inspectDatabase(
  catalog: MigrationCatalog,
  header: DatabaseHeader,
): DatabaseCompatibility {
  if (!validCatalog(catalog)) return { kind: "refuse", reason: "invalidCatalog" };
  const latest = catalog.steps.at(-1)?.to ?? catalog.initial;
  if (header.format > latest) return { kind: "refuse", reason: "futureFormat" };
  if (header.ledger.length > catalog.steps.length)
    return { kind: "refuse", reason: "unknownMigration" };
  for (const [i, entry] of header.ledger.entries()) {
    const known = catalog.steps[i];
    if (!known || !sameStep(known, entry)) return { kind: "refuse", reason: "unknownMigration" };
  }
  if ((header.ledger.at(-1)?.to ?? catalog.initial) !== header.format)
    return { kind: "refuse", reason: "invalidLedger" };
  const next = catalog.steps[header.ledger.length];
  return next ? { kind: "migrationRequired", next } : { kind: "open" };
}

export type InstanceIdentity = {
  environmentId: EnvironmentId;
  stateDirectory: string;
  instanceId: HostInstanceId;
  version: string;
};
const instanceIdentity = {
  environmentId: EnvironmentIdSchema,
  stateDirectory: text,
  instanceId: HostInstanceIdSchema,
};
export const InstancePublicationSchema = v.strictObject({
  ...instanceIdentity,
  endpoint: text,
  pid: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  version: text,
});
export type InstancePublication = v.InferOutput<typeof InstancePublicationSchema>;
export type WriterLockObservation =
  | { kind: "acquired"; owner: InstanceIdentity }
  | { kind: "held"; owner: InstanceIdentity; publication: InstancePublication | null };
const writerBrand: unique symbol = Symbol("directory writer");
export type DirectoryWriter = InstanceIdentity & { readonly [writerBrand]: true };
export type WriterDecision =
  | { kind: "writer"; lease: DirectoryWriter }
  | { kind: "existingInstance"; instance: InstancePublication }
  | { kind: "wait" };
function sameInstance(a: InstanceIdentity, b: InstanceIdentity) {
  return (
    a.environmentId === b.environmentId &&
    a.stateDirectory === b.stateDirectory &&
    a.instanceId === b.instanceId &&
    a.version === b.version
  );
}
/** The host supplies the outcome of an atomic OS lock acquisition. A stale instance file is never a lock grant. */
export function observeWriter(
  start: InstanceIdentity,
  lock: WriterLockObservation,
): WriterDecision {
  if (
    start.stateDirectory !== lock.owner.stateDirectory ||
    start.environmentId !== lock.owner.environmentId
  )
    return { kind: "wait" };
  if (lock.kind === "acquired")
    return sameInstance(start, lock.owner)
      ? { kind: "writer", lease: { ...start, [writerBrand]: true } }
      : { kind: "wait" };
  return lock.publication && sameInstance(lock.owner, lock.publication)
    ? { kind: "existingInstance", instance: lock.publication }
    : { kind: "wait" };
}

const directory = { environmentId: EnvironmentIdSchema, stateDirectory: text };
const plan = {
  ...directory,
  commandId: CommandIdSchema,
  previous: ReleaseSchema,
  target: ReleaseSchema,
};
export const UpgradeBackupSchema = v.strictObject({
  ...directory,
  commandId: CommandIdSchema,
  version: text,
  path: text,
  digest: ReleaseSchema.entries.digest,
  header: DatabaseHeaderSchema,
});
export type UpgradeBackup = v.InferOutput<typeof UpgradeBackupSchema>;
export const UpgradeStateSchema = v.variant("phase", [
  v.strictObject({ phase: v.literal("idle"), ...directory, active: ReleaseSchema }),
  v.strictObject({ phase: v.literal("staged"), ...plan }),
  v.strictObject({ phase: v.literal("verified"), ...plan, backup: UpgradeBackupSchema }),
  v.strictObject({ phase: v.literal("migrating"), ...plan, backup: UpgradeBackupSchema }),
  v.strictObject({
    phase: v.literal("rollingBack"),
    ...plan,
    backup: UpgradeBackupSchema,
    reason: text,
  }),
  v.strictObject({ phase: v.literal("committed"), ...plan, backup: UpgradeBackupSchema }),
  v.strictObject({ phase: v.literal("rolledBack"), ...plan, reason: text }),
]);
export type UpgradeState = v.InferOutput<typeof UpgradeStateSchema>;
/** Reconnect reads the actual active pointer. Paths, the backup and the database journal remain host-local. */
export function upgradeView(
  state: UpgradeState,
  activeVersion: ActiveReleasePointer["version"],
): UpgradeView {
  if (state.phase === "idle") return { phase: "idle", activeVersion };
  const versions = {
    activeVersion,
    commandId: state.commandId,
    previousVersion: state.previous.version,
    targetVersion: state.target.version,
  };
  return state.phase === "rollingBack" || state.phase === "rolledBack"
    ? { ...versions, phase: state.phase, reason: state.reason }
    : { ...versions, phase: state.phase };
}
type ActiveUpgrade = Exclude<UpgradeState, { phase: "idle" }>;
type MigrationState = Extract<UpgradeState, { phase: "migrating" }>;
export type UpgradeObservation = {
  activeVersion: ActiveReleasePointer["version"];
  database: DatabaseHeader;
  artifact:
    | { kind: "verified"; version: string; digest: string }
    | { kind: "invalid" | "unavailable" };
  restoredBackupDigest: string | null;
  backup: UpgradeBackup | null;
  health: "ready" | "notStarted" | "failed";
};
function sameDirectory(
  a: Pick<InstanceIdentity, "stateDirectory" | "environmentId">,
  b: Pick<InstanceIdentity, "stateDirectory" | "environmentId">,
) {
  return a.stateDirectory === b.stateDirectory && a.environmentId === b.environmentId;
}
function backupMatches(s: ActiveUpgrade, backup: UpgradeBackup | null): backup is UpgradeBackup {
  return (
    backup !== null &&
    sameDirectory(s, backup) &&
    backup.commandId === s.commandId &&
    backup.version === s.previous.version &&
    inspectDatabase(s.previous.catalog, backup.header).kind === "open" &&
    (!("backup" in s) || (s.backup.path === backup.path && s.backup.digest === backup.digest))
  );
}
function compatibleSuccessor(previous: Release, target: Release) {
  if (
    previous.version === target.version ||
    !validCatalog(previous.catalog) ||
    !validCatalog(target.catalog) ||
    previous.catalog.initial !== target.catalog.initial
  )
    return false;
  return previous.catalog.steps.every((step, i) => {
    const other = target.catalog.steps[i];
    return other !== undefined && sameStep(step, other);
  });
}
export type UpgradeEvent =
  | { kind: "stage"; commandId: CommandId; target: Release }
  | { kind: "verify" | "beginMigration" | "commit" | "finish"; commandId: CommandId }
  | { kind: "beginRollback" | "rolledBack"; commandId: CommandId; reason: string };
export type UpgradeAction =
  | {
      kind:
        | "serve"
        | "stageBackup"
        | "verifyBackup"
        | "beginRollback"
        | "activatePrevious"
        | "recordRollback"
        | "activateTarget"
        | "beginMigration"
        | "recordCommit"
        | "startTarget"
        | "finish"
        | "servePrevious"
        | "restoreBackup"
        | "rejectStage"
        | "inspect";
    }
  | { kind: "migrate"; step: Migration };

/** Read persisted facts after every crash. An already committed new format always goes forward with its compatible binary. */
export function recoverUpgrade(
  state: UpgradeState,
  observation: UpgradeObservation,
): UpgradeAction {
  const o = observation;
  if (state.phase === "idle")
    return o.activeVersion === state.active.version &&
      inspectDatabase(state.active.catalog, o.database).kind === "open"
      ? { kind: "serve" }
      : { kind: "inspect" };
  const old = o.activeVersion === state.previous.version,
    target = o.activeVersion === state.target.version;
  if (!old && !target) return { kind: "inspect" };
  if (!compatibleSuccessor(state.previous, state.target)) return { kind: "inspect" };
  const verified =
    o.artifact.kind === "verified" &&
    o.artifact.version === state.target.version &&
    o.artifact.digest === state.target.digest;
  const before = inspectDatabase(state.previous.catalog, o.database),
    after = inspectDatabase(state.target.catalog, o.database);
  if (state.phase === "rolledBack")
    return old && before.kind === "open" ? { kind: "servePrevious" } : { kind: "inspect" };
  if (after.kind === "refuse") return { kind: "inspect" };
  switch (state.phase) {
    case "staged":
      if (!old || before.kind !== "open") return { kind: "inspect" };
      return verified
        ? { kind: backupMatches(state, o.backup) ? "verifyBackup" : "stageBackup" }
        : o.artifact.kind === "invalid"
          ? { kind: "rejectStage" }
          : { kind: "inspect" };
    case "verified":
      if (before.kind !== "open" || !backupMatches(state, o.backup)) return { kind: "inspect" };
      if (o.artifact.kind === "invalid" || o.health === "failed") return { kind: "beginRollback" };
      if (!verified) return { kind: "inspect" };
      return old ? { kind: "activateTarget" } : { kind: "beginMigration" };
    case "migrating":
      if (after.kind === "open") {
        if (!verified) return { kind: "inspect" };
        return target ? { kind: "recordCommit" } : { kind: "activateTarget" };
      }
      if (!backupMatches(state, o.backup)) return { kind: "inspect" };
      if (o.artifact.kind === "invalid" || o.health === "failed") return { kind: "beginRollback" };
      if (!verified) return { kind: "inspect" };
      return old ? { kind: "activateTarget" } : { kind: "migrate", step: after.next };
    case "rollingBack":
      if (!backupMatches(state, o.backup) || (after.kind === "open" && before.kind !== "open"))
        return { kind: "inspect" };
      if (o.restoredBackupDigest !== state.backup.digest) return { kind: "restoreBackup" };
      if (before.kind !== "open") return { kind: "inspect" };
      return old ? { kind: "recordRollback" } : { kind: "activatePrevious" };
    case "committed":
      if (after.kind !== "open" || !verified) return { kind: "inspect" };
      if (!target) return { kind: "activateTarget" };
      return o.health === "ready"
        ? { kind: "finish" }
        : o.health === "notStarted"
          ? { kind: "startTarget" }
          : { kind: "inspect" };
  }
}

export type UpgradeTransition =
  | { kind: "ok"; state: UpgradeState }
  | { kind: "rejected"; reason: "wrongWriter" | "wrongOperation" | "invalidState" };
/** The coordinator persists each returned phase before carrying out its next external action. */
export function transitionUpgrade(
  writer: DirectoryWriter,
  state: UpgradeState,
  event: UpgradeEvent,
  o: UpgradeObservation,
): UpgradeTransition {
  if (!sameDirectory(writer, state)) return { kind: "rejected", reason: "wrongWriter" };
  const invalid = { kind: "rejected", reason: "invalidState" } as const;
  if (event.kind === "stage") {
    if (state.phase !== "idle" || writer.version !== state.active.version) return invalid;
    if (
      recoverUpgrade(state, o).kind !== "serve" ||
      o.artifact.kind !== "verified" ||
      o.artifact.version !== event.target.version ||
      o.artifact.digest !== event.target.digest ||
      !compatibleSuccessor(state.active, event.target)
    )
      return invalid;
    return {
      kind: "ok",
      state: {
        phase: "staged",
        environmentId: state.environmentId,
        stateDirectory: state.stateDirectory,
        commandId: event.commandId,
        previous: state.active,
        target: event.target,
      },
    };
  }
  if (state.phase === "idle" || state.commandId !== event.commandId)
    return { kind: "rejected", reason: "wrongOperation" };
  if (
    (event.kind === "verify" && writer.version !== state.previous.version) ||
    ((event.kind === "beginMigration" || event.kind === "commit" || event.kind === "finish") &&
      writer.version !==
        (state.phase === "rolledBack" ? state.previous.version : state.target.version))
  )
    return { kind: "rejected", reason: "wrongWriter" };
  const action = recoverUpgrade(state, o).kind;
  switch (event.kind) {
    case "verify":
      return state.phase === "staged" && action === "verifyBackup" && backupMatches(state, o.backup)
        ? { kind: "ok", state: { ...state, phase: "verified", backup: o.backup } }
        : invalid;
    case "beginMigration":
      return state.phase === "verified" && action === "beginMigration"
        ? { kind: "ok", state: { ...state, phase: "migrating" } }
        : invalid;
    case "commit":
      return state.phase === "migrating" && action === "recordCommit"
        ? { kind: "ok", state: { ...state, phase: "committed" } }
        : invalid;
    case "finish": {
      const active =
        action === "finish" ? state.target : action === "servePrevious" ? state.previous : null;
      return active
        ? {
            kind: "ok",
            state: {
              phase: "idle",
              active,
              stateDirectory: state.stateDirectory,
              environmentId: state.environmentId,
            },
          }
        : invalid;
    }
    case "beginRollback":
      return (state.phase === "verified" || state.phase === "migrating") &&
        action === "beginRollback"
        ? { kind: "ok", state: { ...state, phase: "rollingBack", reason: event.reason } }
        : invalid;
    case "rolledBack": {
      if (
        !(state.phase === "staged" && action === "rejectStage") &&
        !(state.phase === "rollingBack" && action === "recordRollback")
      )
        return invalid;
      const { environmentId, stateDirectory, commandId, previous, target } = state;
      return {
        kind: "ok",
        state: {
          phase: "rolledBack",
          environmentId,
          stateDirectory,
          commandId,
          previous,
          target,
          reason: state.phase === "rollingBack" ? state.reason : event.reason,
        },
      };
    }
  }
}

/** The object owner applies this step's row changes with this header under the same transaction and base marker. */
export function planMigrationTransaction(
  writer: DirectoryWriter,
  state: MigrationState,
  observed: UpgradeObservation,
  id: Migration["id"],
):
  | { kind: "transaction"; step: Migration; base: DatabaseHeader; after: DatabaseHeader }
  | { kind: "rejected" } {
  if (!sameDirectory(writer, state) || writer.version !== state.target.version)
    return { kind: "rejected" };
  const action = recoverUpgrade(state, observed);
  if (action.kind !== "migrate" || action.step.id !== id) return { kind: "rejected" };
  const step = action.step;
  return {
    kind: "transaction",
    step,
    base: observed.database,
    after: { format: step.to, ledger: [...observed.database.ledger, step] },
  };
}
