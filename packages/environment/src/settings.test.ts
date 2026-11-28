import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  CommandIdSchema,
  CommandReceiptSchema,
  EnvironmentIdSchema,
  ObjectVersionSchema,
  ProjectSchema,
  remoteSettings,
  SettingOverlaySchema,
  SettingReadSchema,
  SettingRowSchema,
  SettingWriteSchema,
  RemoteSettingTargetSchema,
  WorktreeSchema,
} from "@kraka/protocol";
import { applySettingWrite, readSetting, type SettingsSnapshot } from "./settings";

const environmentId = v.parse(EnvironmentIdSchema, "env");
const environment = v.parse(RemoteSettingTargetSchema, { kind: "environment", environmentId });
const project = v.parse(RemoteSettingTargetSchema, {
  kind: "project",
  environmentId,
  projectId: "p",
});
const checkout = v.parse(RemoteSettingTargetSchema, {
  kind: "checkout",
  environmentId,
  projectId: "p",
  worktreeId: "w",
});
const request = v.parse(SettingReadSchema, { field: "directoryMode", target: project, checkout });
const command = v.parse(CommandIdSchema, "write");
const version = v.parse(ObjectVersionSchema, "40");
const base: SettingsSnapshot = {
  environmentId,
  version,
  projects: [v.parse(ProjectSchema, { id: "p", environmentId, version })],
  worktrees: [v.parse(WorktreeSchema, { id: "w", projectId: "p", version })],
  rows: [],
  overlays: [],
};
const row = (target: unknown, value: string, version: string) =>
  v.parse(SettingRowSchema, {
    field: "directoryMode",
    target,
    version,
    explicit: { kind: "set", value },
  });
const overlay = (source: unknown, value: string, version: string) =>
  v.parse(SettingOverlaySchema, { field: "directoryMode", source, value, version });
const edit = (change: unknown, baseVersion = "0") =>
  v.parse(SettingWriteSchema, { ...request, change, baseVersion });

test("resolves the same checkout from versioned inputs regardless of their arrival order", () => {
  const layers = [
    row(environment, "local", "3"),
    row(project, "worktree", "4"),
    row(checkout, "local", "5"),
  ];
  const overlays = [
    overlay({ kind: "organizationDefault", environmentId, policyId: "defaults" }, "worktree", "1"),
    overlay({ ...checkout, kind: "repository", path: "config" }, "local", "2"),
    overlay({ kind: "lock", environmentId, policyId: "operator" }, "worktree", "6"),
  ];
  const views = [
    { rows: layers, overlays, kind: "lock", sourceVersion: "6" },
    { rows: layers, overlays: overlays.slice(0, 2), kind: "checkout", sourceVersion: "5" },
    {
      rows: layers.slice(0, 2),
      overlays: overlays.slice(0, 2),
      kind: "project",
      sourceVersion: "4",
    },
    {
      rows: layers.slice(0, 1),
      overlays: overlays.slice(0, 2),
      kind: "environment",
      sourceVersion: "3",
    },
    { rows: [], overlays: overlays.slice(0, 2), kind: "repository", sourceVersion: "2" },
    { rows: [], overlays: overlays.slice(0, 1), kind: "organizationDefault", sourceVersion: "1" },
    { rows: [], overlays: [], kind: "builtin", sourceVersion: null },
  ];
  for (const view of views) {
    const state = { ...base, rows: view.rows, overlays: view.overlays };
    const first = readSetting(state, request);
    expect(first?.effective).toMatchObject({
      source: { kind: view.kind },
      sourceVersion: view.sourceVersion,
    });
    expect(first?.readVersion).toBe(version);
    expect(
      readSetting(
        { ...state, rows: [...state.rows].reverse(), overlays: [...state.overlays].reverse() },
        request,
      ),
    ).toEqual(first);
  }
});

test("returns the committed target and the different winning checkout value in the same receipt", () => {
  const keep = row(checkout, "local", "7");
  const snapshot = { ...base, rows: [keep] };
  const result = applySettingWrite(snapshot, command, edit({ kind: "set", value: "worktree" }));
  expect(v.parse(CommandReceiptSchema, result.receipt)).toMatchObject({
    kind: "accepted",
    result: {
      kind: "settingSaved",
      supportedFields: expect.arrayContaining(["directoryMode", "defaultModel"]),
      readback: {
        fieldVersion: "1",
        readVersion: "41",
        atLayer: { kind: "set", value: "worktree" },
        effective: { value: "local", source: checkout, sourceVersion: "7" },
      },
    },
  });
  expect(result.snapshot.rows[0]).toBe(keep);
  expect(snapshot.rows).toEqual([keep]);
  const repeated = applySettingWrite(
    result.snapshot,
    command,
    edit({ kind: "set", value: "worktree" }),
  );
  expect(repeated.snapshot).toBe(result.snapshot);
  expect(repeated.receipt).toEqual(result.receipt);
});

test("preserves explicit defaults and null values, and a reset records an absent row at a new version", () => {
  const fallback = overlay({ ...checkout, kind: "repository", path: "config" }, "local", "8");
  const start = { ...base, overlays: [fallback] };
  const set = applySettingWrite(start, command, edit({ kind: "set", value: "local" })).snapshot;
  expect(readSetting(set, request)?.effective.source.kind).toBe("project");
  const reset = applySettingWrite(
    set,
    v.parse(CommandIdSchema, "reset"),
    edit({ kind: "absent" }, "1"),
  ).snapshot;
  expect(readSetting(reset, request)).toMatchObject({
    fieldVersion: "2",
    atLayer: { kind: "absent" },
    effective: { source: fallback.source, sourceVersion: "8" },
  });
  const noChange = applySettingWrite(
    reset,
    v.parse(CommandIdSchema, "keep-absent"),
    edit({ kind: "absent" }, "0"),
  );
  expect(noChange.snapshot).toBe(reset);
  const model = v.parse(SettingWriteSchema, {
    ...request,
    field: "defaultModel",
    change: { kind: "set", value: null },
    baseVersion: "0",
  });
  expect(applySettingWrite(start, command, model).receipt).toMatchObject({
    kind: "accepted",
    result: {
      readback: {
        atLayer: { kind: "set", value: null },
        effective: { source: project, value: null },
      },
    },
  });
});

test("rejects locks, stale edits and unrelated checkout contexts without changing a row", () => {
  const lockedBy = { kind: "lock", environmentId, policyId: "admin" };
  const locked = { ...base, overlays: [overlay(lockedBy, "local", "6")] };
  const put = edit({ kind: "set", value: "local" });
  expect(applySettingWrite(locked, command, put)).toMatchObject({
    snapshot: locked,
    receipt: { kind: "rejected", failure: { kind: "settingLocked", lockedBy } },
  });
  expect(
    applySettingWrite(base, command, edit({ kind: "set", value: "local" }, "8")).receipt,
  ).toMatchObject({ kind: "rejected", failure: { kind: "settingVersionConflict" } });
  for (const wrong of [
    { ...checkout, projectId: "other" },
    { ...checkout, environmentId: "other" },
    { ...checkout, worktreeId: "missing" },
  ]) {
    expect(
      readSetting(base, v.parse(SettingReadSchema, { ...request, checkout: wrong })),
    ).toBeNull();
  }
  const foreign = overlay(
    { ...checkout, kind: "repository", path: "other", worktreeId: "other" },
    "worktree",
    "9",
  );
  expect(readSetting({ ...base, overlays: [foreign] }, request)?.effective.source.kind).toBe(
    "builtin",
  );
  expect(v.safeParse(SettingOverlaySchema, { ...foreign, field: "defaultModel" }).success).toBe(
    false,
  );
  expect(v.safeParse(SettingWriteSchema, { ...put, target: lockedBy }).success).toBe(false);
});

test("worktree setting definitions expose the specified values and writable layers", () => {
  const location = remoteSettings.find((field) => field.name === "worktreeLocation");
  const naming = remoteSettings.find((field) => field.name === "worktreeBranchNaming");
  const submodules = remoteSettings.find((field) => field.name === "worktreeSubmodules");
  expect(location?.fallback).toEqual({ kind: "default" });
  expect(location?.targets.map((target) => target.entries.kind.literal)).toEqual(["environment"]);
  expect(naming?.fallback).toEqual({ kind: "generated" });
  expect(naming?.targets.map((target) => target.entries.kind.literal)).toEqual([
    "environment",
    "project",
    "checkout",
  ]);
  expect(submodules?.fallback).toBe("recursive");
  expect(submodules?.repository).toBe(true);
  expect(v.parse(RemoteSettingTargetSchema, environment)).toEqual(environment);
  expect(
    v.safeParse(SettingReadSchema, {
      field: "worktreeLocation",
      target: environment,
      checkout: null,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(SettingReadSchema, { field: "worktreeLocation", target: project, checkout })
      .success,
  ).toBe(false);
  expect(
    v.safeParse(SettingWriteSchema, {
      field: "worktreeBranchNaming",
      target: project,
      checkout,
      baseVersion: "0",
      change: { kind: "set", value: { kind: "fixedPrefix", prefix: "feature/work" } },
    }).success,
  ).toBe(true);
  for (const prefix of ["../oops", "-bad", "bad-", "dir.lock/path", "bad//path", "bad..path"]) {
    expect(
      v.safeParse(SettingWriteSchema, {
        field: "worktreeBranchNaming",
        target: project,
        checkout,
        baseVersion: "0",
        change: { kind: "set", value: { kind: "fixedPrefix", prefix } },
      }).success,
    ).toBe(false);
  }
  for (const path of ["relative/path", "/tmp/custom", "D:\\\\worktrees"]) {
    expect(
      v.safeParse(SettingWriteSchema, {
        field: "worktreeLocation",
        target: environment,
        checkout: null,
        baseVersion: "0",
        change: { kind: "set", value: { kind: "custom", path } },
      }).success,
    ).toBe(path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path) || /^\\\\/.test(path));
  }
});

test("structured setting retries keep the saved version and only submodules inherit repository declarations", () => {
  const write = v.parse(SettingWriteSchema, {
    field: "worktreeLocation",
    target: environment,
    checkout: null,
    baseVersion: "0",
    change: { kind: "set", value: { kind: "custom", path: "/worktrees" } },
  });
  const saved = applySettingWrite(base, command, write);
  const retried = applySettingWrite(
    saved.snapshot,
    command,
    v.parse(SettingWriteSchema, JSON.parse(JSON.stringify(write))),
  );
  expect(retried.snapshot).toBe(saved.snapshot);
  expect(retried.receipt).toMatchObject({
    result: { kind: "settingSaved", readback: { fieldVersion: "1" } },
  });
  const source = { ...checkout, kind: "repository", path: "kraka.json" };
  const query = v.parse(SettingReadSchema, {
    field: "worktreeSubmodules",
    target: project,
    checkout,
  });
  const repositoryValue = v.parse(SettingOverlaySchema, {
    field: query.field,
    source,
    value: "topLevel",
    version: "3",
  });
  expect(readSetting({ ...base, overlays: [repositoryValue] }, query)?.effective).toMatchObject({
    value: "topLevel",
    source: { kind: "repository" },
  });
  const override = v.parse(SettingRowSchema, {
    field: query.field,
    target: environment,
    explicit: { kind: "set", value: "none" },
    version: "4",
  });
  expect(
    readSetting({ ...base, overlays: [repositoryValue], rows: [override] }, query)?.effective,
  ).toMatchObject({ value: "none", source: { kind: "environment" } });
  for (const field of ["worktreeBranchNaming", "worktreeLocation"]) {
    expect(
      v.safeParse(SettingOverlaySchema, {
        field,
        source: { kind: "organizationDefault", environmentId, policyId: "policy" },
        value: { kind: field === "worktreeLocation" ? "default" : "generated" },
        version: "1",
      }).success,
    ).toBe(false);
  }
});

test("a stale base succeeds only for the same explicit layer, including a versioned reset", () => {
  const choose = edit({ kind: "set", value: "worktree" });
  const saved = applySettingWrite(base, command, choose);
  const retry = applySettingWrite(saved.snapshot, v.parse(CommandIdSchema, "already-set"), choose);
  expect(retry.snapshot).toBe(saved.snapshot);
  expect(retry.receipt).toMatchObject({
    result: {
      kind: "settingSaved",
      readback: {
        fieldVersion: "1",
        readVersion: "41",
        atLayer: choose.change,
        effective: { value: "worktree", source: project },
      },
    },
  });
  expect(
    applySettingWrite(saved.snapshot, command, edit({ kind: "absent" })).receipt,
  ).toMatchObject({
    failure: {
      kind: "settingVersionConflict",
      readback: { fieldVersion: "1", atLayer: choose.change },
    },
  });
});
