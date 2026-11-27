import * as v from "valibot";
import {
  ObjectVersionSchema,
  type ContextOperation,
  type ContextOperationObservation,
} from "@kraka/protocol";
import { ok, reject, type TransitionResult } from "./result";

function nextVersion(version: ContextOperation["version"]) {
  return v.parse(ObjectVersionSchema, (BigInt(version) + 1n).toString());
}

/** Apply only correlated results. Replays preserve the first terminal observation and its object version. */
export function transitionContextOperation(
  current: ContextOperation,
  observation: ContextOperationObservation,
): TransitionResult<ContextOperation> {
  if (
    current.action !== observation.action ||
    current.threadId !== observation.threadId ||
    current.deliveryId !== observation.deliveryId
  )
    return reject("wrongDelivery");

  const acceptedAt = current.state.acceptedAt;
  if (observation.state.kind === "accepted") return ok(current);
  const version = nextVersion(current.version);
  if (observation.state.kind === "unknown") {
    if (current.state.kind !== "accepted") return ok(current);
    if (observation.state.observedAt < acceptedAt) return reject("invalidState");
    return ok({ ...current, version, state: { ...observation.state, acceptedAt } });
  }
  if (observation.state.kind === "failed") {
    if (observation.state.failedAt < acceptedAt) return reject("invalidState");
    if (current.state.kind === "completed") return reject("idConflict");
    if (current.state.kind === "failed")
      return current.state.reason === observation.state.reason ? ok(current) : reject("idConflict");
    return ok({ ...current, version, state: { ...observation.state, acceptedAt } });
  }
  if (observation.state.completedAt < acceptedAt) return reject("invalidState");
  if (current.state.kind === "failed") return reject("idConflict");
  if (current.action === "compact" && observation.action === "compact") {
    if (current.state.kind === "completed")
      return current.state.summary === observation.state.summary &&
        current.state.firstKeptEntryId === observation.state.firstKeptEntryId
        ? ok(current)
        : reject("idConflict");
    return ok({ ...current, version, state: { ...observation.state, acceptedAt } });
  }
  if (current.action === "clear" && observation.action === "clear") {
    if (current.state.kind === "completed")
      return current.state.nativeSessionId === observation.state.nativeSessionId
        ? ok(current)
        : reject("idConflict");
    return ok({ ...current, version, state: { ...observation.state, acceptedAt } });
  }
  return reject("wrongDelivery");
}
