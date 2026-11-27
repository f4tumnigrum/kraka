import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ExecutorSessionObservationSchema,
  AttemptIdSchema,
  NativeObservationRelationshipSchema,
  NativeSessionIdSchema,
} from "@kraka/protocol";
import type { AdapterEventPayload } from "./adapter-contract";
import { promoteSessionObservation } from "./session-observations";

const observation = v.parse(ExecutorSessionObservationSchema, {
  kind: "executorObservation",
  id: "timeline-item",
  threadId: "thread",
  source: {
    instanceId: "opencode",
    nativeSessionId: "native-session",
    epoch: 3,
    eventId: "event-9",
    sourceId: "native-execution",
  },
  category: "turn",
  observedAt: 500,
  redactedSummary: "Execution completed.",
  assignment: { kind: "session" },
  createdPosition: "18",
  version: "1",
});

test("session-only adapter events keep no invented attempt and promote once after explicit native correlation", () => {
  const event: AdapterEventPayload = {
    kind: "sessionObservation",
    sourceId: "event-9",
    category: "turn",
    observedAt: 500,
    redactedSummary: "A native execution event without a linked request.",
  };
  expect(event.kind).toBe("sessionObservation");
  const link = {
    kind: "attempt" as const,
    source: observation.source,
    attemptId: v.parse(AttemptIdSchema, "attempt"),
    relationship: v.parse(NativeObservationRelationshipSchema, {
      kind: "root",
      nativeRootTurnId: "root",
    }),
  };
  const promoted = promoteSessionObservation(observation, link);
  expect(promoted).toMatchObject({
    kind: "ok",
    value: { assignment: { kind: "attempt", attemptId: "attempt" }, version: "2" },
  });
  if (promoted.kind !== "ok") throw new Error("Expected explicit session event correlation");
  expect(promoteSessionObservation(promoted.value, link)).toEqual(promoted);
  expect(
    promoteSessionObservation(observation, {
      ...link,
      source: {
        ...link.source,
        nativeSessionId: v.parse(NativeSessionIdSchema, "another-session"),
      },
    }),
  ).toEqual({
    kind: "rejected",
    reason: "wrongAttempt",
  });
  expect(
    promoteSessionObservation(promoted.value, {
      ...link,
      relationship: v.parse(NativeObservationRelationshipSchema, {
        kind: "root",
        nativeRootTurnId: "different-root",
      }),
    }),
  ).toEqual({ kind: "rejected", reason: "idConflict" });
});
