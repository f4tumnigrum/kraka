import { ExecutorPrincipalSchema, REQUEST_METHODS, AttemptIdSchema } from "@kraka/protocol";
import { permitsChildLaunch, type ParentToolScope } from "./tool-scope";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AppCallbackSchema,
  AppConfirmationSchema,
  AppNoteKeySchema,
  DeliveryIdSchema,
  SecretReceiptSchema,
} from "@kraka/protocol";
import { checkAppCallback, editAppNote } from "./app-callback";
import { secretFileGrant } from "./secret-file";
const source = {
  environmentId: "env",
  threadId: "t",
  itemId: "original",
  instanceId: "inst",
  sessionId: "s",
  attemptId: "a",
  generation: 2,
  serviceId: "service",
};
test("only a live original app can dispatch the confirmed operation and payload", () => {
  const callback = v.parse(AppCallbackSchema, {
    source,
    action: { kind: "tool", name: "write", argumentsJson: "{}" },
  });
  const confirm = v.parse(AppConfirmationSchema, {
    source,
    commandId: "c",
    confirmedBy: "owner",
    payloadDigest: "a".repeat(64),
    issuedAt: 10,
    expiresAt: 50,
  });
  const runtime = {
    source: callback.source,
    tools: new Map([["write", { readOnly: false, permissions: ["workspace.change"] as const }]]),
    resources: new Set<string>(),
  };
  const run = (digest: string, now: number, grant = true) =>
    checkAppCallback(
      callback,
      runtime,
      confirm.commandId,
      digest,
      confirm.confirmedBy,
      grant ? new Set(["thread.view", "workspace.change"]) : new Set(["thread.view"]),
      now,
      confirm,
    );
  expect(run(confirm.payloadDigest, 20)).toBe("allowed");
  expect(run(confirm.payloadDigest, 20, false)).toBe("missingPermission");
  expect(run("b".repeat(64), 20)).toBe("confirmationRequired");
  expect(run(confirm.payloadDigest, 50)).toBe("confirmationRequired");
  expect(
    checkAppCallback(
      callback,
      { ...runtime, source: { ...runtime.source, generation: 3 } },
      confirm.commandId,
      confirm.payloadDigest,
      confirm.confirmedBy,
      new Set(["thread.view", "workspace.change"]),
      20,
      confirm,
    ),
  ).toBe("sessionStopped");
});
test("clearing an app note retains the version and a stale write cannot revive it", () => {
  const key = v.parse(AppNoteKeySchema, {
    targetThreadId: "t",
    source: { environmentId: "env", threadId: "t", itemId: "original" },
  });
  const first = editAppNote(key, null, null, "hello", 1);
  if (typeof first === "string") throw new Error(first);
  const cleared = editAppNote(key, first, first.version, "", 2);
  if (typeof cleared === "string") throw new Error(cleared);
  expect(cleared.text).toBeNull();
  expect(editAppNote(key, cleared, first.version, "late", 3)).toBe("conflict");
  expect(editAppNote(key, cleared, cleared.version, "€".repeat(5500), 3)).toBe("tooLarge");
});
test("a winning private receipt grants file delivery only for the originally confirmed command", () => {
  const target = {
    environmentId: "env",
    projectId: "p",
    threadId: "t",
    todoRequestId: "todo",
    version: "2",
    attemptId: "a",
    instanceId: "inst",
    sessionId: "s",
    requestId: "r",
    purpose: { kind: "commandFile", tool: "reader", commandId: "file-command" },
  };
  const receipt = v.parse(SecretReceiptSchema, {
    receiptCommandId: "receipt",
    ownerId: "owner",
    target,
    savedAt: 1,
    expiresAt: 10,
    decision: "stored",
  });
  const winner = {
    ownerId: receipt.ownerId,
    receiptCommandId: receipt.receiptCommandId,
    decisionCommandId: receipt.receiptCommandId,
  };
  const delivery = v.parse(DeliveryIdSchema, "delivery");
  expect(secretFileGrant(receipt, receipt.target, winner, delivery, 9)?.deliveryId).toBe(delivery);
  expect(secretFileGrant(receipt, receipt.target, winner, delivery, 10)).toBeNull();
  expect(
    secretFileGrant(
      receipt,
      { ...receipt.target, purpose: { kind: "toolOnce", tool: "reader" } },
      winner,
      delivery,
      9,
    ),
  ).toBeNull();
  expect(
    secretFileGrant({ ...receipt, decision: "declined" }, receipt.target, winner, delivery, 9),
  ).toBeNull();
});

test("launching children checks the current parent attempt and each destination checkout", () => {
  const principal = v.parse(ExecutorPrincipalSchema, {
    kind: "executor",
    id: "worker",
    threadId: "parent",
    attemptId: "try",
    executorInstanceId: "inst",
  });
  const request = v.parse(REQUEST_METHODS.launchChildren.schema, {
    kind: "signedRequest",
    method: "thread.launchChildren",
    protocolVersion: { major: 1, minor: 0 },
    environmentId: "env",
    connectionId: "c",
    challengeId: "ch",
    challenge: "A".repeat(43),
    signature: "B".repeat(86),
    commandId: "batch",
    sequence: 2,
    signer: { kind: "executor", principalId: "worker", keyId: "k" },
    payload: {
      threadId: "parent",
      mode: "delegate",
      items: [
        { childCommandId: "child", projectId: "p", instruction: "review", checkout: "isolated" },
      ],
    },
  });
  const project = request.payload.items[0].projectId;
  const scope: ParentToolScope = {
    environmentId: request.environmentId,
    threadId: principal.threadId,
    instanceId: principal.executorInstanceId,
    attemptId: principal.attemptId,
    principalId: principal.id,
    projects: new Map([[project, new Set(["isolated"])]]),
  };
  const explicit = v.parse(REQUEST_METHODS.launchChildren.schema, {
    ...request,
    payload: {
      ...request.payload,
      items: [{ ...request.payload.items[0], requestedMode: "open" }],
    },
  });
  expect(permitsChildLaunch({ ...scope, childModeCeiling: () => "ask" }, principal, explicit)).toBe(
    false,
  );
  expect(
    permitsChildLaunch({ ...scope, childModeCeiling: () => "open" }, principal, explicit),
  ).toBe(true);
  expect(permitsChildLaunch(scope, principal, request)).toBe(true);
  expect(permitsChildLaunch({ ...scope, projects: new Map() }, principal, request)).toBe(false);
  expect(
    permitsChildLaunch(
      { ...scope, attemptId: v.parse(AttemptIdSchema, "other") },
      principal,
      request,
    ),
  ).toBe(false);
  expect(
    permitsChildLaunch(scope, principal, {
      ...request,
      payload: { ...request.payload, items: [request.payload.items[0], request.payload.items[0]] },
    }),
  ).toBe(false);
});
