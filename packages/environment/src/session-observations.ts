import * as v from "valibot";
import { ObjectVersionSchema, type ExecutorSessionObservation } from "@kraka/protocol";
import { ok, reject, type TransitionResult } from "./result";

type SessionObservationLink = Extract<
  ExecutorSessionObservation["assignment"],
  { kind: "attempt" }
> & { source: ExecutorSessionObservation["source"] };

function sameRelationship(
  left: SessionObservationLink["relationship"],
  right: SessionObservationLink["relationship"],
) {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case "root":
      return right.kind === "root" && left.nativeRootTurnId === right.nativeRootTurnId;
    case "item":
      return right.kind === "item" && left.nativeItemId === right.nativeItemId;
    case "request":
      return right.kind === "request" && left.nativeRequestId === right.nativeRequestId;
  }
}

/** Promote one session-only fact after an explicit native relationship proves its active attempt. */
export function promoteSessionObservation(
  observation: ExecutorSessionObservation,
  link: SessionObservationLink,
): TransitionResult<ExecutorSessionObservation> {
  const { source } = observation;
  if (
    source.nativeSessionId !== link.source.nativeSessionId ||
    source.instanceId !== link.source.instanceId ||
    source.epoch !== link.source.epoch ||
    source.eventId !== link.source.eventId ||
    source.sourceId !== link.source.sourceId
  )
    return reject("wrongAttempt");
  if (observation.assignment.kind === "attempt") {
    const isSameAssignment =
      observation.assignment.attemptId === link.attemptId &&
      sameRelationship(observation.assignment.relationship, link.relationship);
    return isSameAssignment ? ok(observation) : reject("idConflict");
  }
  return ok({
    ...observation,
    assignment: { kind: "attempt", attemptId: link.attemptId, relationship: link.relationship },
    version: v.parse(ObjectVersionSchema, (BigInt(observation.version) + 1n).toString()),
  });
}
