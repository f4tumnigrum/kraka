import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ContextOperationReceiptSchema,
  ObjectChangeSchema,
  REQUEST_METHODS,
  SignedRequestSchema,
} from "./index";

const envelope = {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "environment",
  connectionId: "connection",
  challengeId: "challenge-id",
  challenge: "A".repeat(43),
  signer: { kind: "device", deviceId: "device", keyId: "key" },
  sequence: 1,
  commandId: "command",
  signature: "A".repeat(86),
};

test("compact and clear are distinct signed thread operations", () => {
  expect(REQUEST_METHODS.compactThread.method).toBe("thread.compact");
  expect(REQUEST_METHODS.clearThread.method).toBe("thread.clear");
  expect(REQUEST_METHODS.compactThread.permission).toBe("thread.send");
  expect(
    v.safeParse(SignedRequestSchema, {
      ...envelope,
      method: "thread.compact",
      payload: { threadId: "thread", instructions: null },
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(SignedRequestSchema, {
      ...envelope,
      method: "thread.clear",
      payload: { threadId: "thread" },
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(SignedRequestSchema, {
      ...envelope,
      method: "thread.clear",
      payload: { threadId: "thread", instructions: null },
    }).success,
  ).toBe(false);
});

test("context operation receipts distinguish acceptance from a verified terminal outcome", () => {
  const accepted = {
    kind: "contextOperation",
    operation: {
      action: "compact",
      threadId: "thread",
      deliveryId: "compact-delivery",
      version: "1",
      state: { kind: "accepted", acceptedAt: 100 },
    },
  };
  expect(v.parse(ContextOperationReceiptSchema, accepted).operation.state.kind).toBe("accepted");
  expect(
    v.parse(ObjectChangeSchema, {
      kind: "context.operation",
      operation: {
        ...accepted.operation,
        state: { kind: "unknown", acceptedAt: 100, observedAt: 120 },
        version: "2",
      },
    }),
  ).toMatchObject({ operation: { state: { kind: "unknown" }, version: "2" } });
  expect(
    v.safeParse(ContextOperationReceiptSchema, {
      kind: "contextOperation",
      operation: {
        action: "clear",
        threadId: "thread",
        deliveryId: "clear-delivery",
        version: "1",
        state: { kind: "completed", acceptedAt: 100, completedAt: 101, summary: "invented" },
      },
    }).success,
  ).toBe(false);
});
