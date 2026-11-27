import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ContextOperationObservationSchema,
  ContextOperationSchema,
  DeliveryIdSchema,
  NativeSessionIdSchema,
  type ContextOperation,
} from "@kraka/protocol";
import { transitionContextOperation } from "./context-operations";

function accepted(action: "compact" | "clear"): ContextOperation {
  return v.parse(ContextOperationSchema, {
    action,
    threadId: "thread",
    deliveryId: `${action}-delivery`,
    version: "1",
    state: { kind: "accepted", acceptedAt: 100 },
  });
}

test("compact settles only from its matching accepted delivery and retains its first result", () => {
  const initial = accepted("compact");
  const observation = v.parse(ContextOperationObservationSchema, {
    action: "compact",
    threadId: "thread",
    deliveryId: "compact-delivery",
    state: {
      kind: "completed",
      completedAt: 120,
      summary: "The source is ready.",
      firstKeptEntryId: "entry-4",
    },
  });
  const result = transitionContextOperation(initial, observation);
  expect(result).toMatchObject({
    kind: "ok",
    value: { version: "2", state: { kind: "completed", acceptedAt: 100 } },
  });
  if (result.kind !== "ok") throw new Error("Expected matching compact result");
  expect(transitionContextOperation(result.value, observation)).toEqual(result);
  expect(
    transitionContextOperation(
      result.value,
      v.parse(ContextOperationObservationSchema, {
        ...observation,
        state: { ...observation.state, summary: "A different summary" },
      }),
    ),
  ).toEqual({ kind: "rejected", reason: "idConflict" });
  expect(
    transitionContextOperation(initial, {
      ...observation,
      deliveryId: v.parse(DeliveryIdSchema, "another-delivery"),
    }),
  ).toEqual({
    kind: "rejected",
    reason: "wrongDelivery",
  });
  expect(
    transitionContextOperation(
      initial,
      v.parse(ContextOperationObservationSchema, {
        ...observation,
        state: { ...observation.state, completedAt: 99 },
      }),
    ),
  ).toEqual({
    kind: "rejected",
    reason: "invalidState",
  });
});

test("unknown clear remains recoverable by a later matching new-session proof", () => {
  const initial = accepted("clear");
  const unknown = transitionContextOperation(
    initial,
    v.parse(ContextOperationObservationSchema, {
      action: "clear",
      threadId: "thread",
      deliveryId: "clear-delivery",
      state: { kind: "unknown", observedAt: 110 },
    }),
  );
  expect(unknown).toMatchObject({
    kind: "ok",
    value: { version: "2", state: { kind: "unknown" } },
  });
  if (unknown.kind !== "ok") throw new Error("Expected unknown result");
  const completed = transitionContextOperation(
    unknown.value,
    v.parse(ContextOperationObservationSchema, {
      action: "clear",
      threadId: "thread",
      deliveryId: "clear-delivery",
      state: {
        kind: "completed",
        completedAt: 130,
        nativeSessionId: v.parse(NativeSessionIdSchema, "new-session"),
      },
    }),
  );
  expect(completed).toMatchObject({
    kind: "ok",
    value: {
      version: "3",
      state: { kind: "completed", acceptedAt: 100, nativeSessionId: "new-session" },
    },
  });
  expect(
    transitionContextOperation(
      initial,
      v.parse(ContextOperationObservationSchema, {
        action: "clear",
        threadId: "thread",
        deliveryId: "clear-delivery",
        state: {
          kind: "completed",
          completedAt: 99,
          nativeSessionId: v.parse(NativeSessionIdSchema, "new-session"),
        },
      }),
    ),
  ).toEqual({ kind: "rejected", reason: "invalidState" });
});
