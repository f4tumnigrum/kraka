import { expect, test } from "bun:test";
import * as v from "valibot";
import { CommandIdSchema, EnvironmentIdSchema, HostInstanceIdSchema } from "@kraka/protocol";
import {
  DatabaseHeaderSchema,
  MigrationSchema,
  ReleaseSchema,
  ActiveReleasePointerSchema,
  UpgradeStateSchema,
  upgradeView,
  UpgradeBackupSchema,
  releaseDirectory,
  inspectDatabase,
  observeWriter,
  recoverUpgrade,
  transitionUpgrade,
  planMigrationTransaction,
  type DirectoryWriter,
  type InstanceIdentity,
  type UpgradeState,
  type UpgradeObservation,
  type UpgradeEvent,
} from "./migrations";

const env = v.parse(EnvironmentIdSchema, "env"),
  commandId = v.parse(CommandIdSchema, "upgrade");
const old = v.parse(ReleaseSchema, {
  version: "1.0.0",
  digest: "a".repeat(64),
  catalog: { initial: 1, steps: [] },
});
const first = v.parse(MigrationSchema, { id: "first", from: 1, to: 2 }),
  last = v.parse(MigrationSchema, { id: "second", from: 2, to: 3 });
const next = v.parse(ReleaseSchema, {
  version: "2.0.0",
  digest: "b".repeat(64),
  catalog: { initial: 1, steps: [first, last] },
});
const db = v.parse(DatabaseHeaderSchema, { format: 1, ledger: [] });
const directory = { environmentId: env, stateDirectory: "state-dir" };
const idle: UpgradeState = { phase: "idle", ...directory, active: old };
const backup = v.parse(UpgradeBackupSchema, {
  ...directory,
  commandId,
  version: old.version,
  path: "backups/verified-copy",
  digest: "c".repeat(64),
  header: db,
});
const observations: UpgradeObservation = {
  activeVersion: old.version,
  database: db,
  artifact: { kind: "verified", version: next.version, digest: next.digest },
  backup: null,
  health: "notStarted",
  restoredBackupDigest: null,
};
const oldInstance = {
  ...directory,
  version: old.version,
  instanceId: v.parse(HostInstanceIdSchema, "old-instance"),
};
const targetInstance = {
  ...directory,
  version: next.version,
  instanceId: v.parse(HostInstanceIdSchema, "target-instance"),
};
function acquire(start: InstanceIdentity) {
  const result = observeWriter(start, { kind: "acquired", owner: start });
  if (result.kind !== "writer") throw new Error("Expected one writer");
  return result.lease;
}
const oldWriter = acquire(oldInstance),
  targetWriter = acquire(targetInstance);
function move(
  writer: DirectoryWriter,
  state: UpgradeState,
  event: UpgradeEvent,
  observation: UpgradeObservation,
): UpgradeState {
  const r = transitionUpgrade(writer, state, event, observation);
  if (r.kind !== "ok") throw new Error(r.reason);
  return r.state;
}
function crash(state: UpgradeState) {
  return v.parse(UpgradeStateSchema, JSON.parse(JSON.stringify(state)));
}
function toMigration() {
  const staged = move(oldWriter, idle, { kind: "stage", commandId, target: next }, observations);
  const verified = move(
    oldWriter,
    crash(staged),
    { kind: "verify", commandId },
    { ...observations, backup },
  );
  const o = { ...observations, backup, activeVersion: next.version };
  const migrating = move(targetWriter, crash(verified), { kind: "beginMigration", commandId }, o);
  if (migrating.phase !== "migrating") throw new Error("Expected migration");
  return { staged, verified, migrating, o };
}

test("recovers staging, backup, activation, each migration commit, pointer repair and endpoint publication", () => {
  const { staged, verified, migrating, o } = toMigration();
  const pointer = v.parse(ActiveReleasePointerSchema, { version: old.version });
  expect(releaseDirectory(pointer)).toBe(releaseDirectory(old));
  expect(v.safeParse(ActiveReleasePointerSchema, { version: "../elsewhere" }).success).toBe(false);
  expect(releaseDirectory(old)).toBe("releases/1.0.0");
  expect(releaseDirectory(next)).toBe("releases/2.0.0");
  expect(recoverUpgrade(crash(idle), observations)).toEqual({ kind: "serve" });
  expect(recoverUpgrade(crash(staged), observations)).toEqual({ kind: "stageBackup" });
  expect(recoverUpgrade(crash(staged), { ...observations, backup })).toEqual({
    kind: "verifyBackup",
  });
  expect(recoverUpgrade(crash(verified), { ...observations, backup })).toEqual({
    kind: "activateTarget",
  });
  expect(recoverUpgrade(crash(verified), o)).toEqual({ kind: "beginMigration" });
  expect(recoverUpgrade(crash(migrating), o)).toEqual({ kind: "migrate", step: first });
  // Interrupt before the row transaction commits: both its data and its ledger entry remain at the base.
  const tx = planMigrationTransaction(targetWriter, migrating, o, first.id);
  if (tx.kind !== "transaction") throw new Error("Expected first migration");
  expect(planMigrationTransaction(targetWriter, migrating, o, first.id)).toEqual(tx);
  expect(tx.base).toEqual({ format: 1, ledger: [] });
  const partial = {
    ...o,
    database: v.parse(DatabaseHeaderSchema, JSON.parse(JSON.stringify(tx.after))),
  };
  expect(partial.database).toEqual({ format: 2, ledger: [first] });
  expect(recoverUpgrade(crash(migrating), partial)).toEqual({ kind: "migrate", step: last });
  expect(planMigrationTransaction(targetWriter, migrating, partial, first.id).kind).toBe(
    "rejected",
  );
  const tx2 = planMigrationTransaction(targetWriter, migrating, partial, last.id);
  if (tx2.kind !== "transaction") throw new Error("Expected final migration");
  const finished = { ...o, database: tx2.after };
  expect(recoverUpgrade(crash(migrating), { ...finished, activeVersion: old.version })).toEqual({
    kind: "activateTarget",
  });
  expect(recoverUpgrade(crash(migrating), finished)).toEqual({ kind: "recordCommit" });
  const committed = move(targetWriter, crash(migrating), { kind: "commit", commandId }, finished);
  expect(recoverUpgrade(crash(committed), finished)).toEqual({ kind: "startTarget" });
  expect(recoverUpgrade(crash(committed), { ...finished, activeVersion: old.version })).toEqual({
    kind: "activateTarget",
  });
  const ready = { ...finished, health: "ready" as const };
  expect(recoverUpgrade(crash(committed), ready)).toEqual({ kind: "finish" });
  expect(move(targetWriter, committed, { kind: "finish", commandId }, ready)).toEqual({
    ...idle,
    active: next,
  });
});

test("restarts a failed partial migration from its verified backup and never reverses a fully committed new format", () => {
  const { migrating, o } = toMigration();
  const broken = { ...o, database: { format: 2, ledger: [first] }, health: "failed" as const };
  expect(recoverUpgrade(crash(migrating), broken)).toEqual({ kind: "beginRollback" });
  const restoring = move(
    targetWriter,
    migrating,
    { kind: "beginRollback", commandId, reason: "migration failed" },
    broken,
  );
  expect(recoverUpgrade(crash(restoring), broken)).toEqual({ kind: "restoreBackup" });
  expect(
    transitionUpgrade(
      targetWriter,
      restoring,
      { kind: "rolledBack", commandId, reason: "done" },
      broken,
    ).kind,
  ).toBe("rejected");
  const restored = { ...broken, database: db, restoredBackupDigest: backup.digest };
  expect(recoverUpgrade(crash(restoring), restored)).toEqual({ kind: "activatePrevious" });
  const switched = { ...restored, activeVersion: old.version };
  expect(recoverUpgrade(crash(restoring), switched)).toEqual({ kind: "recordRollback" });
  const rolled = move(
    oldWriter,
    restoring,
    { kind: "rolledBack", commandId, reason: "done" },
    switched,
  );
  expect(rolled).toMatchObject({ phase: "rolledBack", reason: "migration failed" });
  expect(recoverUpgrade(crash(rolled), switched)).toEqual({ kind: "servePrevious" });
  expect(upgradeView(rolled, switched.activeVersion)).toEqual({
    phase: "rolledBack",
    commandId,
    activeVersion: old.version,
    previousVersion: old.version,
    targetVersion: next.version,
    reason: "migration failed",
  });
  expect(move(oldWriter, rolled, { kind: "finish", commandId }, switched)).toEqual(idle);
  const complete = { ...broken, database: { format: 3, ledger: [first, last] } };
  expect(recoverUpgrade(crash(migrating), complete)).toEqual({ kind: "recordCommit" });
  expect(
    transitionUpgrade(
      targetWriter,
      migrating,
      { kind: "beginRollback", commandId, reason: "failed endpoint" },
      complete,
    ).kind,
  ).toBe("rejected");
  expect(recoverUpgrade(crash(restoring), complete)).toEqual({ kind: "inspect" });
  const committed = move(targetWriter, migrating, { kind: "commit", commandId }, complete);
  expect(recoverUpgrade(crash(committed), complete)).toEqual({ kind: "inspect" });
  expect(
    transitionUpgrade(
      targetWriter,
      committed,
      { kind: "rolledBack", commandId, reason: "try reverse" },
      complete,
    ).kind,
  ).toBe("rejected");
});

test("an older release refuses a future marker or an unknown migration without changing any metadata", () => {
  const future = { format: 3, ledger: [first, last] },
    unknown = { format: 1, ledger: [first] };
  for (const [header, reason] of [
    [future, "futureFormat"],
    [unknown, "unknownMigration"],
  ] as const) {
    const before = JSON.stringify(header);
    expect(inspectDatabase(old.catalog, header)).toEqual({ kind: "refuse", reason });
    expect(JSON.stringify(header)).toBe(before);
  }
  expect(inspectDatabase(next.catalog, { format: 3, ledger: [first] })).toEqual({
    kind: "refuse",
    reason: "invalidLedger",
  });
  expect(inspectDatabase(next.catalog, { format: 2, ledger: [last] })).toEqual({
    kind: "refuse",
    reason: "unknownMigration",
  });
  expect(inspectDatabase({ initial: 1, steps: [first, first] }, db)).toEqual({
    kind: "refuse",
    reason: "invalidCatalog",
  });
  expect(inspectDatabase(next.catalog, { format: 3, ledger: [first, last] })).toEqual({
    kind: "open",
  });
});

test("only the winner of a state-directory lock writes and the loser gets the winner's actual endpoint", () => {
  const a = oldInstance,
    b = targetInstance;
  for (const [winner, loser] of [
    [a, b],
    [b, a],
  ] as const) {
    const publication = { ...winner, pid: 7, endpoint: "local-socket" };
    expect(observeWriter(winner, { kind: "acquired", owner: winner }).kind).toBe("writer");
    expect(observeWriter(loser, { kind: "held", owner: winner, publication })).toEqual({
      kind: "existingInstance",
      instance: publication,
    });
    expect(observeWriter(loser, { kind: "held", owner: winner, publication: null })).toEqual({
      kind: "wait",
    });
    expect(
      observeWriter(loser, {
        kind: "held",
        owner: winner,
        publication: { ...publication, instanceId: loser.instanceId },
      }),
    ).toEqual({ kind: "wait" });
    expect(observeWriter(loser, { kind: "acquired", owner: loser }).kind).toBe("writer");
  }
  const { migrating, o } = toMigration();
  expect(planMigrationTransaction(oldWriter, migrating, o, first.id).kind).toBe("rejected");
  const elsewhere = acquire({ ...targetInstance, stateDirectory: "other-state" });
  expect(planMigrationTransaction(elsewhere, migrating, o, first.id).kind).toBe("rejected");
  expect(transitionUpgrade(elsewhere, migrating, { kind: "commit", commandId }, o)).toMatchObject({
    kind: "rejected",
    reason: "wrongWriter",
  });
});

test("rejects a damaged staged package and refuses to migrate with a foreign or missing backup", () => {
  const { staged, verified, migrating, o } = toMigration();
  const bad = { ...observations, artifact: { kind: "invalid" as const } };
  expect(recoverUpgrade(staged, bad)).toEqual({ kind: "rejectStage" });
  const rolled = move(
    oldWriter,
    staged,
    { kind: "rolledBack", commandId, reason: "digest mismatch" },
    bad,
  );
  expect(recoverUpgrade(crash(rolled), bad)).toEqual({ kind: "servePrevious" });
  expect(recoverUpgrade(verified, { ...o, backup: null })).toEqual({ kind: "inspect" });
  const wrong = { ...o, backup: { ...backup, commandId: v.parse(CommandIdSchema, "other") } };
  expect(planMigrationTransaction(targetWriter, migrating, wrong, first.id).kind).toBe("rejected");
  expect(
    planMigrationTransaction(
      targetWriter,
      migrating,
      { ...o, artifact: { kind: "verified", version: next.version, digest: old.digest } },
      first.id,
    ).kind,
  ).toBe("rejected");
  expect(
    transitionUpgrade(
      oldWriter,
      staged,
      { kind: "verify", commandId: v.parse(CommandIdSchema, "foreign") },
      { ...observations, backup },
    ),
  ).toMatchObject({ kind: "rejected", reason: "wrongOperation" });
});
