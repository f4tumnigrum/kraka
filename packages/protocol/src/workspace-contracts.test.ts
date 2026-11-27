import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  SignedRequestSchema,
  PrivateSecretRequestSchema,
  readPrivateSecretRequest,
  REQUEST_METHODS,
  hasMethodPermissions,
  EXECUTOR_TOOL_METHODS,
  DataMessageSchema,
  DESKTOP_IPC,
  DiffRequestSchema,
  DiffResultSchema,
  RollbackProgressSchema,
  AppNoteReadSchema,
  WorkspaceFileReadSchema,
  WorkspaceSearchResultSchema,
  EarlierSettledPageSchema,
} from "./index";
const signed = {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "env",
  connectionId: "c",
  challengeId: "cid",
  challenge: "A".repeat(43),
  signer: { kind: "device", deviceId: "d", keyId: "k" },
  sequence: 2,
  commandId: "op",
  signature: "B".repeat(86),
};
const workspace = { kind: "thread", threadId: "t", directoryId: "dir", generation: "1" };
test("keeps confidential submissions out of public requests and negotiates the device-only reader", () => {
  const raw = {
    ...signed,
    method: "todo.submitSecret",
    payload: {
      choice: { kind: "value", value: "fake-example" },
      target: {
        environmentId: "env",
        projectId: "p",
        threadId: "t",
        todoRequestId: "todo",
        version: "1",
        attemptId: "a",
        instanceId: "inst",
        sessionId: "native",
        requestId: "request",
        purpose: { kind: "toolOnce", tool: "sample" },
      },
    },
  };
  expect(v.safeParse(SignedRequestSchema, raw).success).toBe(false);
  expect(readPrivateSecretRequest(raw, []).kind).toBe("unsupported");
  expect(readPrivateSecretRequest(raw, ["privateSecretSubmission"]).kind).toBe("request");
  expect(
    v.safeParse(PrivateSecretRequestSchema, {
      ...raw,
      signer: { kind: "executor", principalId: "p", keyId: "k" },
    }).success,
  ).toBe(false);
});
test("keeps file prefixes, partial searches, and Git updates explicitly scoped", () => {
  const read = {
    kind: "truncated",
    target: workspace,
    path: "notes.txt",
    prefix: "hello",
    readBytes: 5,
    totalBytes: 10,
  };
  expect(v.safeParse(WorkspaceFileReadSchema, read).success).toBe(true);
  expect(v.safeParse(WorkspaceFileReadSchema, { ...read, kind: "complete" }).success).toBe(false);
  expect(
    v.safeParse(WorkspaceSearchResultSchema, {
      coverage: "partial",
      hits: [],
      next: null,
      reason: "indexIncomplete",
    }).success,
  ).toBe(true);
  const write = REQUEST_METHODS.writeWorkspaceFile;
  expect(hasMethodPermissions(write, new Set(["thread.view"]))).toBe(false);
  expect(hasMethodPermissions(write, new Set(["workspace.change"]))).toBe(false);
  expect(hasMethodPermissions(write, new Set(["workspace.change", "thread.view"]))).toBe(true);
  expect(
    v.safeParse(DataMessageSchema, {
      kind: "git.status",
      subscriptionId: "s",
      snapshot: {
        kind: "branch",
        target: workspace,
        sequence: 7,
        head: { kind: "detached", tip: "a".repeat(40) },
      },
    }).success,
  ).toBe(true);
});
test("keeps cross-round boundaries, patch truncation and file recovery permission independent", () => {
  expect(
    v.safeParse(DiffRequestSchema, {
      kind: "roundRange",
      threadId: "t",
      worktreeId: "w",
      fromCaptureId: "first",
      toCaptureId: "last",
    }).success,
  ).toBe(true);
  const end = { kind: "round", boundary: "after", captureId: "last", commit: "a".repeat(40) };
  expect(
    v.safeParse(DiffResultSchema, {
      kind: "changed",
      from: end,
      to: end,
      files: [
        {
          path: "n",
          previousPath: null,
          change: "modified",
          owner: { kind: "unknown", reason: "noObservation" },
        },
      ],
      patch: "prefix",
      truncated: true,
      next: null,
    }).success,
  ).toBe(true);
  const target = {
    threadId: "t",
    roundId: "r",
    attemptId: "a",
    worktreeId: null,
    nativeSessionId: "s",
    nativeRootTurnId: "root",
    boundary: "before",
  };
  expect(
    v.safeParse(SignedRequestSchema, {
      ...signed,
      method: "checkpoint.rollbackDialogue",
      payload: target,
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(SignedRequestSchema, {
      ...signed,
      method: "checkpoint.restoreFiles",
      payload: target,
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(RollbackProgressSchema, {
      commandId: "op",
      target,
      dialogue: { kind: "pending", execution: 1 },
      files: { kind: "running", execution: 1 },
    }).success,
  ).toBe(false);
});
test("desktop channels and parent-thread tools have bounded targets", () => {
  expect(
    v.safeParse(DESKTOP_IPC.connectRoute.input, {
      environmentId: "e",
      routeId: "r",
      command: "arbitrary",
    }).success,
  ).toBe(false);
  expect(v.safeParse(DESKTOP_IPC.openExternalLink.input, { url: "file:///outside" }).success).toBe(
    false,
  );
  expect(EXECUTOR_TOOL_METHODS.launchChildren.target).toBe("thread");
  expect(REQUEST_METHODS.startThread.target).toBe("project");
  const page = {
    environmentId: "env",
    databaseGeneration: "db",
    visibilityGeneration: "v",
    scope: { kind: "list", projectId: "p" },
    shapeVersion: 1,
    through: "2",
  };
  expect(
    v.safeParse(EarlierSettledPageSchema, {
      through: page,
      threads: [],
      counts: { active: 2, pinned: 1, settled: 4, archived: 0, snoozed: 0 },
      next: null,
    }).success,
  ).toBe(true);
  for (const result of [{ kind: "empty" }, { kind: "failed", reason: "unavailable" }])
    expect(v.safeParse(AppNoteReadSchema, { threadId: "t", deliveryId: "d", result }).success).toBe(
      true,
    );
  expect(
    v.safeParse(AppNoteReadSchema, {
      threadId: "t",
      deliveryId: "d",
      result: { kind: "present", notes: [] },
    }).success,
  ).toBe(false);
});
