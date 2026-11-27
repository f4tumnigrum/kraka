export type RejectionReason =
  | "invalidState"
  | "wrongAttempt"
  | "wrongDelivery"
  | "wrongNativeRoot"
  | "wrongCapture"
  | "queueHeld"
  | "notQueueHead"
  | "idConflict"
  | "alreadyAnswered"
  | "routeUnavailable"
  | "wrongRequest";

export type TransitionResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; reason: RejectionReason };
export function ok<T>(value: T): TransitionResult<T> {
  return { kind: "ok", value };
}
export function reject(reason: RejectionReason): { kind: "rejected"; reason: RejectionReason } {
  return { kind: "rejected", reason };
}
export function unexpected(value: never): never {
  throw new Error(`Unhandled internal variant: ${String(value)}`);
}
