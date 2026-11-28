import type {
  AttemptId,
  CheckpointCapture,
  CaptureId,
  DeliveryId,
  NativeRoot,
  ReceiptProof,
  RoundAttempt,
  RoundPhase,
  RoundEndTimeEvidence,
} from "@kraka/protocol";
import { ok, reject, unexpected, type TransitionResult } from "./result";

export type DeliveryRecovery = "deduplicate" | "query" | "none";
type RootEnd =
  | { outcome: "completed"; captureId: CaptureId }
  | { outcome: Extract<RoundPhase, { kind: "endedEarly" }>["reason"] };
type RootObservation =
  | { kind: "rootStarted"; root: NativeRoot }
  | ({
      kind: "rootEnded";
      root: NativeRoot;
      endedAt: number;
      endTimeEvidence?: RoundEndTimeEvidence;
      nativeReason?: string | null;
      failure?: { kind: string; message: string };
    } & RootEnd);
export type RoundReport = { attemptId: AttemptId; deliveryId: DeliveryId } & (
  | { kind: "written"; at: number }
  | { kind: "received"; proof: ReceiptProof }
  | { kind: "handled"; at: number }
  | {
      kind: "sessionLost";
      at: number;
      failure: Extract<RoundPhase, { kind: "interrupted" }>["failure"];
    }
  | { kind: "unknown" }
  | { kind: "refused"; reason: string }
  | { kind: "absentAfterFence" }
  | { kind: "observationLost" }
  | RootObservation
  | { kind: "captureSettled"; capture: CheckpointCapture }
);

function sameReceipt(left: ReceiptProof, right: ReceiptProof) {
  return left.sessionId === right.sessionId && left.itemId === right.itemId;
}
function sameRoot(left: NativeRoot, right: NativeRoot) {
  return left.sessionId === right.sessionId && left.id === right.id;
}

/** Only a matching attempt and native root can close work. First observations retain their timestamps on replay. */
export function transitionRound(
  attempt: RoundAttempt,
  event: RoundReport,
): TransitionResult<RoundPhase> {
  if (event.attemptId !== attempt.attemptId) return reject("wrongAttempt");
  if (event.deliveryId !== attempt.deliveryId) return reject("wrongDelivery");
  const phase = attempt.phase;
  switch (event.kind) {
    case "handled":
      if (phase.kind === "handled") return ok(phase);
      return phase.kind === "armed" || phase.kind === "handed"
        ? ok({ kind: "handled", handledAt: event.at })
        : reject("invalidState");
    case "sessionLost": {
      if (phase.kind === "interrupted") return ok(phase);
      const seen = phase.kind === "unobserved" ? phase.seen : phase;
      return seen.kind === "working" || seen.kind === "root"
        ? ok({
            kind: "interrupted",
            root: seen.root,
            receipt: seen.receipt,
            observedAt: event.at,
            failure: event.failure,
          })
        : reject("invalidState");
    }
    case "written":
      if (phase.kind === "handed") return ok(phase);
      return phase.kind === "armed"
        ? ok({ kind: "handed", wroteAt: event.at })
        : reject("invalidState");
    case "received": {
      switch (phase.kind) {
        case "armed":
        case "handed":
        case "recovering":
        case "uncertain":
          return ok({ kind: "received", proof: event.proof });
        case "received":
          return sameReceipt(phase.proof, event.proof) ? ok(phase) : reject("wrongDelivery");
        case "notDelivered":
          if (phase.lateReceipt && !sameReceipt(phase.lateReceipt, event.proof))
            return reject("wrongDelivery");
          return ok({ ...phase, lateReceipt: event.proof });
        case "working":
        case "closing":
        case "finished":
        case "endedEarly":
          if (
            phase.root.sessionId !== event.proof.sessionId ||
            (phase.receipt && !sameReceipt(phase.receipt, event.proof))
          )
            return reject("wrongDelivery");
          return ok({ ...phase, receipt: event.proof });
        case "unobserved": {
          const seen = phase.seen;
          if (seen.kind === "input")
            return sameReceipt(seen.proof, event.proof) ? ok(phase) : reject("wrongDelivery");
          if (
            seen.root.sessionId !== event.proof.sessionId ||
            (seen.receipt && !sameReceipt(seen.receipt, event.proof))
          )
            return reject("wrongDelivery");
          return ok({ ...phase, seen: { ...seen, receipt: event.proof } });
        }
        case "interrupted":
        case "handled":
        case "filed":
          return reject("invalidState");
        default:
          return unexpected(phase);
      }
    }
    case "unknown":
      if (phase.kind === "uncertain" || phase.kind === "unobserved") return ok(phase);
      if (phase.kind === "armed" || phase.kind === "handed" || phase.kind === "recovering")
        return ok({ kind: "uncertain", next: "inspectInput" });
      return reject("invalidState");
    case "refused":
      if (
        phase.kind !== "armed" &&
        phase.kind !== "handed" &&
        phase.kind !== "uncertain" &&
        phase.kind !== "recovering"
      )
        return reject("invalidState");
      return ok({ kind: "notDelivered", reason: event.reason, lateReceipt: null });
    case "absentAfterFence":
      // The adapter must fence the old sender and cover all receipts before reporting absence.
      if (phase.kind !== "recovering" || phase.action !== "inspectInput")
        return reject("invalidState");
      return ok({ kind: "filed", gate: phase.gate });
    case "observationLost":
      if (phase.kind === "unobserved") return ok(phase);
      if (phase.kind === "received")
        return ok({
          kind: "unobserved",
          next: "inspectRoot",
          seen: { kind: "input", proof: phase.proof },
        });
      if (phase.kind === "working")
        return ok({
          kind: "unobserved",
          next: "inspectRoot",
          seen: { kind: "root", root: phase.root, receipt: phase.receipt },
        });
      return reject("invalidState");
    case "rootStarted": {
      let receipt: ReceiptProof | null = null;
      switch (phase.kind) {
        case "working":
          return sameRoot(phase.root, event.root) ? ok(phase) : reject("wrongNativeRoot");
        case "armed":
        case "handed":
        case "recovering":
        case "uncertain":
          break;
        case "received":
          if (phase.proof.sessionId !== event.root.sessionId) return reject("wrongNativeRoot");
          receipt = phase.proof;
          break;
        case "unobserved":
          if (phase.seen.kind === "root") {
            if (!sameRoot(phase.seen.root, event.root)) return reject("wrongNativeRoot");
            return ok({ kind: "working", root: phase.seen.root, receipt: phase.seen.receipt });
          }
          if (phase.seen.proof.sessionId !== event.root.sessionId) return reject("wrongNativeRoot");
          receipt = phase.seen.proof;
          break;
        case "interrupted":
        case "handled":
        case "filed":
        case "closing":
        case "finished":
        case "endedEarly":
        case "notDelivered":
          return reject("invalidState");
        default:
          return unexpected(phase);
      }
      if (receipt && receipt.sessionId !== event.root.sessionId) return reject("wrongNativeRoot");
      return ok({ kind: "working", root: event.root, receipt });
    }
    case "rootEnded": {
      if (phase.kind === "closing" || phase.kind === "finished" || phase.kind === "endedEarly") {
        if (!sameRoot(phase.root, event.root)) return reject("wrongNativeRoot");
        if (phase.kind === "endedEarly")
          return phase.reason === event.outcome ? ok(phase) : reject("invalidState");
        return event.outcome === "completed" && phase.captureId === event.captureId
          ? ok(phase)
          : reject("invalidState");
      }
      if (
        phase.kind === "filed" ||
        phase.kind === "notDelivered" ||
        phase.kind === "handled" ||
        phase.kind === "interrupted"
      )
        return reject("invalidState");
      // A correlated native terminal response can be the first observation of this root.
      const seen = phase.kind === "unobserved" ? phase.seen : phase;
      const recorded = seen.kind === "working" || seen.kind === "root" ? seen : null;
      const root = recorded?.root.beganAt != null ? recorded.root : event.root;
      if (recorded && !sameRoot(recorded.root, event.root)) return reject("wrongNativeRoot");
      const receipt =
        seen.kind === "received" || seen.kind === "input"
          ? seen.proof
          : (recorded?.receipt ?? null);
      if (receipt && receipt.sessionId !== root.sessionId) return reject("wrongNativeRoot");
      if (root.beganAt !== null && event.endedAt < root.beganAt) return reject("invalidState");
      const evidence = event.endTimeEvidence;
      if (evidence?.source === "executorReported" && evidence.executorEndedAt !== event.endedAt)
        return reject("invalidState");
      if (
        evidence?.source === "environmentObserved" &&
        evidence.environmentObservedAt !== event.endedAt
      )
        return reject("invalidState");
      const ended = {
        root,
        receipt,
        endedAt: event.endedAt,
        ...(evidence === undefined ? {} : { endTimeEvidence: evidence }),
        ...(event.nativeReason === undefined ? {} : { nativeReason: event.nativeReason }),
      };
      return event.outcome === "completed"
        ? ok({ kind: "closing", ...ended, captureId: event.captureId })
        : ok({
            kind: "endedEarly",
            ...ended,
            reason: event.outcome,
            ...(event.failure ? { failure: event.failure } : {}),
          });
    }
    case "captureSettled":
      if (phase.kind !== "closing" && phase.kind !== "finished") return reject("invalidState");
      if (phase.captureId !== event.capture.id) return reject("wrongCapture");
      if (attempt.attemptId !== event.capture.attemptId) return reject("wrongAttempt");
      return ok({ ...phase, kind: "finished" });
    default:
      return unexpected(event);
  }
}

/** The environment reuses the original ticket when recovery is safe. Query-only recovery waits for a receipt or fenced absence. */
export function recoverInputDelivery(
  phase: RoundPhase,
  source: "person" | "automation",
  recovery: DeliveryRecovery,
): RoundPhase {
  const gate = source === "person" ? "held" : "eligible";
  switch (phase.kind) {
    case "filed":
      return source === "automation" && recovery === "none"
        ? { kind: "uncertain", next: "inspectInput" }
        : { ...phase, gate };
    case "armed":
    case "handed":
    case "recovering":
      if (recovery === "none") return { kind: "uncertain", next: "inspectInput" };
      return {
        kind: "recovering",
        gate,
        prior: phase.kind === "recovering" ? phase.prior : phase,
        action: recovery === "query" ? "inspectInput" : "retrySameDelivery",
      };
    case "working":
      return {
        kind: "unobserved",
        next: "inspectRoot",
        seen: { kind: "root", root: phase.root, receipt: phase.receipt },
      };
    case "received":
      return {
        kind: "unobserved",
        next: "inspectRoot",
        seen: { kind: "input", proof: phase.proof },
      };
    case "uncertain":
    case "unobserved":
    case "closing":
    case "finished":
    case "endedEarly":
    case "handled":
    case "interrupted":
    case "notDelivered":
      return phase;
    default:
      return unexpected(phase);
  }
}
