import * as v from "valibot";
import type {
  LoginFlow,
  LoginResult,
  ModelCatalog,
  AuthenticationResult,
} from "./executor-records";
import type {
  AttemptId,
  DeliveryId,
  ExecutorInstanceId,
  HandoffContext,
  InstancePermission,
  Message,
  MessageId,
  NativeItemId,
  NativeRequestId,
  NativeRootTurnId,
  NativeSessionId,
  RoundEndTimeEvidence,
  ExecutorSessionObservationPayload,
  NativeObservationRelationship,
  ToolActivityFileChange,
  ContextOperationObservation,
  TodoAnswer,
  TodoRequestBody,
} from "@kraka/protocol";

import {
  CapabilityMatrixSchema,
  type AdapterFamily,
  type CapabilityId,
  type CapabilitySupport,
  type CapabilityMatrix,
} from "@kraka/protocol";
export {
  ADAPTER_FAMILIES,
  CAPABILITY_IDS,
  CAPABILITY_LABELS,
  AdapterFamilySchema,
  CapabilityIdSchema,
  CapabilitySupportSchema,
  CapabilityMatrixSchema,
  CAPABILITY_GROUPS,
  type AdapterFamily,
  type CapabilityId,
  type CapabilitySupport,
  type CapabilityMatrix,
  type CapabilityGroup,
} from "@kraka/protocol";

export function parseCapabilityMatrix(value: unknown): AdapterCallResult<CapabilityMatrix> {
  const parsed = v.safeParse(CapabilityMatrixSchema, value);
  return parsed.success
    ? { kind: "ok", value: parsed.output }
    : { kind: "rejected", reason: "invalidCapabilitySnapshot", message: null };
}

export type AdapterRejectedReason =
  | "unsupported"
  | "notFound"
  | "alreadyClosed"
  | "idConflict"
  | "wrongFamily"
  | "invalidCapabilitySnapshot"
  | "notAuthenticated"
  | "usageLimited"
  | "requestExpired"
  | "unsafeToRetry"
  | "invalidState"
  | "operationRejected";

/** Expected operational failures are values. An adapter implementation bug throws as a program error. */
export type AdapterCallResult<T> =
  | { kind: "ok"; value: T }
  | { kind: "rejected"; reason: AdapterRejectedReason; message: string | null };

export type AdapterInstance<F extends AdapterFamily = AdapterFamily> = {
  family: F;
  instanceId: ExecutorInstanceId;
};
export type AdapterSessionBinding<F extends AdapterFamily = AdapterFamily> = {
  family: F;
  instanceId: ExecutorInstanceId;
  nativeSessionId: NativeSessionId | null;
  epoch: number;
};
export type ReadinessLayer = "configured" | "installed" | "authenticated" | "model" | "operation";
export type Readiness = { state: "yes" | "no" | "unknown"; verifiedAt: number | null };
export type ReceiptGuarantee = "proof" | "none" | "unknown";
export type RetryScope = "sameSession" | "acrossRestart" | "none" | "unknown";
export type DeliveryGuarantee = {
  receipt: ReceiptGuarantee;
  deduplicate: RetryScope;
  query: RetryScope;
};
export type SteeringMode = "queueNext" | "insertCurrent" | "restartCurrent";
export type PayloadKind = "text" | "image" | "file";
export type SessionRecovery = "liveOnly" | "afterSessionLoss" | "messageFallback" | "notResumable";
export type PermissionEffectiveAt = "now" | "nextTool" | "nextTurn" | "restart" | "unknown";

export type CapabilityDeclaration<F extends AdapterFamily = AdapterFamily> = {
  family: F;
  version: number;
  checkedAt: number;
  readiness: Readonly<Record<ReadinessLayer, Readiness>>;
  matrix: CapabilityMatrix;
  input: DeliveryGuarantee;
  answer: DeliveryGuarantee;
  steering: Readonly<
    Record<
      SteeringMode,
      {
        support: CapabilitySupport;
        readReceipt: "yes" | "no" | "unknown";
        accepts: readonly PayloadKind[];
      }
    >
  >;
  requests: Readonly<Record<"approval" | "question", { afterSessionLoss: SessionRecovery }>>;
  permission: {
    modes: readonly string[];
    enforcement: "native" | "adapter" | "unknown";
    changeEffective: PermissionEffectiveAt;
  };
  textGeneration?: CapabilitySupport;
  endReasons: readonly RoundEnd["reason"][];
  childWork: "unsupported" | "nativeTask" | "workflow" | "nativeTaskAndWorkflow";
};

export type AdapterCapability = CapabilityId | "generateText";
export type ActionPermit<F extends AdapterFamily, C extends AdapterCapability> = {
  instanceId: ExecutorInstanceId;
  family: F;
  capabilityVersion: number;
  capability: C;
  support: Exclude<CapabilitySupport, { kind: "unsupported" }>;
};
export type SessionSetup = {
  workingDirectory: string;
  additionalDirectories: readonly string[];
  environment: Readonly<Record<string, string>>;
  model: { id: string; options: Readonly<Record<string, string | number | boolean>> };
  permission: InstancePermission;
};
export type OpenSessionInput<F extends AdapterFamily> = {
  instance: AdapterInstance<F>;
  resume: NativeSessionId | null;
  attemptId: AttemptId;
  setup: SessionSetup;
};
/** Text has already been expanded. References identify its sources and must not be expanded a second time. */
export type AdapterInput = Pick<Message, "id" | "text" | "attachments" | "references">;
export type AdapterJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly AdapterJsonValue[]
  | { readonly [key: string]: AdapterJsonValue };
type Service<C extends AdapterCapability, R extends { kind: string }> = {
  kind: "service";
  capability: C;
  deliveryId: DeliveryId;
  request: R;
};
type ServiceCommand =
  | Service<"startLogin", { kind: "login"; flow: LoginFlow }>
  | Service<"checkAuthentication", { kind: "checkAuthentication" }>
  | Service<"listModels", { kind: "listModels" }>
  | Service<"generateText", { kind: "generateText"; prompt: string }>
  | Service<"changeModel", { kind: "changeModel"; model: SessionSetup["model"] }>
  | Service<
      "setModelOptions",
      { kind: "setModelOptions"; options: SessionSetup["model"]["options"] }
    >
  | Service<"reportTokenUsage", { kind: "usage"; scope: "round" | "session" }>
  | Service<"reportQuota", { kind: "quota" }>
  | Service<"reportCost", { kind: "cost"; scope: "round" | "session" }>
  | Service<"compactContext", { kind: "compact"; instructions: string | null }>
  | Service<"startSession", { kind: "handoff" } & HandoffContext>
  | Service<
      "provideTools",
      { kind: "provideTools"; tools: readonly { name: string; configuration: AdapterJsonValue }[] }
    >
  | Service<"stopRound", { kind: "stopChild"; childId: NativeRootTurnId }>;
export type ServiceRequest = ServiceCommand["request"];
export type InstanceServiceCommand = Extract<
  ServiceCommand,
  { capability: "generateText" | "startLogin" | "checkAuthentication" | "listModels" }
>;
type InstanceResults = {
  startLogin: LoginResult;
  checkAuthentication: AuthenticationResult;
  listModels: ModelCatalog;
  generateText: { text: string };
};
export type InstanceServiceResult<C extends InstanceServiceCommand> = {
  kind: "service";
  result: InstanceResults[C["capability"]];
};

export type AdapterCommand =
  | {
      kind: "deliverInput";
      capability: "submitTextInput" | "submitImageInput" | "submitFileInput";
      deliveryId: DeliveryId;
      attemptId: AttemptId;
      input: AdapterInput;
    }
  | {
      kind: "deliverAnswer";
      capability: "answerApprovalChoices";
      deliveryId: DeliveryId;
      attemptId: AttemptId;
      requestId: NativeRequestId;
      answer: TodoAnswer;
      reply?: import("@kraka/protocol").TodoReplyContent;
    }
  | { kind: "stop"; capability: "stopRound"; deliveryId: DeliveryId; attemptId: AttemptId }
  | {
      kind: "steer";
      capability: "steerCurrentRound" | "queueNextInput" | "steerCurrentWithAttachments";
      deliveryId: DeliveryId;
      attemptId: AttemptId;
      mode: SteeringMode;
      input: AdapterInput;
    }
  | {
      kind: "inspect";
      capability: "readHistory";
      deliveryId: DeliveryId;
      attemptId: AttemptId;
      subject: "input" | "answer" | "steer";
    }
  | ServiceCommand
  | {
      kind: "setPermission";
      capability: "selectPermissionMode" | "changePermissionDuringRun";
      deliveryId: DeliveryId;
      selected: string;
    }
  | {
      kind: "nativeAction";
      capability: "forkAtRound" | "rollbackRounds" | "clearSession" | "readHistory";
      deliveryId: DeliveryId;
      action: "fork" | "rollback" | "clear" | "readHistory";
      target: NativeRootTurnId | null;
    };

export type InspectionResult =
  | { kind: "found"; nativeId: NativeItemId | NativeRequestId }
  | { kind: "definitelyAbsent" }
  | { kind: "unknown" };
export type InvocationResult =
  | { kind: "written"; deliveryId: DeliveryId }
  | { kind: "inspection"; result: InspectionResult }
  | { kind: "history"; rows: readonly AdapterJsonValue[]; next: string | null }
  | { kind: "nativeBinding"; nativeSessionId: NativeSessionId }
  | { kind: "contextOperation"; result: ContextOperationObservation }
  | { kind: "service"; result: AdapterJsonValue };
export type AdapterFailure =
  | { kind: "unexpectedExit"; code: number | null; signal: string | null }
  | { kind: "protocolError"; message: string }
  | { kind: "authentication"; message: string }
  | { kind: "usageLimit"; resetAt: number | null }
  | { kind: "transportError"; message: string }
  | { kind: "operationRejected"; message: string }
  | { kind: "unknown"; message: string };
export type ApprovalAuthority = {
  permission: import("@kraka/protocol").PermissionItem;
  choices: readonly Extract<import("@kraka/protocol").TodoReplyContent, { kind: "approval" }>[];
};
export type RequestBody = TodoRequestBody;
export type Recovery = SessionRecovery;
export type RoundEnd =
  | { reason: "failed"; failure: AdapterFailure; nativeReason: string | null }
  | {
      reason: "completed" | "stopped" | "superseded" | "unknown";
      nativeReason: string | null;
    };
export type NativeReceipt =
  | { kind: "input" | "steer"; sessionId: NativeSessionId; itemId: NativeItemId }
  | { kind: "answer"; sessionId: NativeSessionId; requestId: NativeRequestId };
export type AdapterEventPayload =
  | { kind: "deliveryWritten"; deliveryId: DeliveryId; attemptId: AttemptId; at: number }
  | {
      kind: "deliveryReceived";
      deliveryId: DeliveryId;
      attemptId: AttemptId;
      receipt: NativeReceipt;
    }
  | { kind: "roundStarted"; attemptId: AttemptId; nativeRootTurnId: NativeRootTurnId; at: number }
  | {
      kind: "contentDelta";
      attemptId: AttemptId;
      itemId: NativeItemId;
      role: "assistant" | "reasoning";
      text: string;
      finalText: string | null;
    }
  | {
      kind: "toolActivity";
      attemptId: AttemptId;
      callId: NativeItemId;
      relationship?: NativeObservationRelationship;
      observation?: { eventId: string; sourceId: string };
      changes?: readonly ToolActivityFileChange[];
      phase: "started" | "progress" | "ended";
      input: AdapterJsonValue | null;
      output: AdapterJsonValue | null;
    }
  | {
      kind: "planChanged";
      attemptId: AttemptId;
      items: readonly { id: string; text: string; state: "pending" | "active" | "complete" }[];
    }
  | {
      kind: "requestOpened";
      attemptId: AttemptId;
      requestId: NativeRequestId;
      recovery: Recovery;
      body: RequestBody;
      approval?: ApprovalAuthority;
      nativeNode?: NativeItemId;
      fallback?: Extract<
        Extract<
          import("@kraka/protocol").TodoRoute,
          { kind: "live"; subject: "question" }
        >["fallback"],
        { kind: "asMessage" }
      >;
    }
  | { kind: "requestClosed"; attemptId: AttemptId; requestId: NativeRequestId }
  | { kind: "steerRead"; attemptId: AttemptId; messageId: MessageId }
  | {
      kind: "childChanged";
      attemptId: AttemptId;
      childId: NativeRootTurnId;
      parentId: NativeRootTurnId;
      origin: "nativeTask" | "workflow";
      state: "started" | "active" | "completed" | "failed" | "stopped";
    }
  | {
      kind: "fileChanged";
      itemId?: import("@kraka/protocol").NativeItemId;
      attemptId: AttemptId;
      path: string;
      change: "created" | "modified" | "deleted" | "moved";
      destination: string | null;
      patch: string | null;
    }
  | {
      kind: "usageUpdated";
      attemptId: AttemptId;
      scope: "step" | "round" | "session";
      counters: Readonly<Record<string, number | null>>;
      cost: number | null;
      currency: string | null;
      priceSource: "reported" | "estimated" | "unknown";
    }
  | {
      kind: "nativeActionCompleted";
      deliveryId: DeliveryId;
      action: "rollback" | "fork" | "readHistory";
      result: "completed" | "failed";
      nativeRootTurnId: NativeRootTurnId | null;
    }
  | {
      kind: "nativeActionCompleted";
      deliveryId: DeliveryId;
      action: "clear";
      result: "completed" | "failed";
      nativeSessionId: NativeSessionId | null;
    }
  | {
      kind: "permissionApplied";
      attemptId: AttemptId;
      effectiveAt: PermissionEffectiveAt;
      toolId: NativeItemId | null;
      mode: string;
      enforcement: "native" | "adapter" | "unknown";
    }
  | {
      kind: "roundEnded";
      attemptId: AttemptId;
      nativeRootTurnId: NativeRootTurnId;
      endedAt: number;
      endTimeEvidence: RoundEndTimeEvidence;
      outcome: RoundEnd;
    }
  | ({ kind: "sessionObservation"; sourceId: string } & ExecutorSessionObservationPayload)
  | { kind: "contextOperation"; result: ContextOperationObservation }
  | { kind: "sessionLost"; failure: AdapterFailure };
export type AdapterEventEnvelope<F extends AdapterFamily = AdapterFamily> = AdapterInstance<F> & {
  sessionId: NativeSessionId;
  epoch: number;
  eventId: string;
  payload: AdapterEventPayload;
};
export type AdapterNormalizerState<F extends AdapterFamily = AdapterFamily> = {
  family: F;
  epoch: number;
  pendingDeliveries: ReadonlyMap<
    string,
    { deliveryId: DeliveryId; attemptId: AttemptId; subject: "input" | "answer" | "steer" }
  >;
  partialContent: ReadonlyMap<string, { role: "assistant" | "reasoning"; text: string }>;
};
export type NormalizedEvents<F extends AdapterFamily = AdapterFamily> = {
  events: readonly AdapterEventPayload[];
  state: AdapterNormalizerState<F>;
};
export type CloseReason = "finished" | "restart" | "shutdown";
export type CapabilityCommand<C extends AdapterCapability = AdapterCapability> = Extract<
  AdapterCommand,
  { capability: C }
>;
export type AdapterSession<F extends AdapterFamily, Handle extends object> = {
  family: F;
  instanceId: ExecutorInstanceId;
  nativeSessionId: NativeSessionId | null;
  epoch: number;
  handle: Handle;
};

export type SessionInvocationResult<C extends AdapterCommand> = C extends InstanceServiceCommand
  ? InstanceServiceResult<C>
  : C extends { capability: "compactContext" }
    ? {
        kind: "contextOperation";
        result: Extract<ContextOperationObservation, { action: "compact" }>;
      }
    : C extends { action: "clear" }
      ? {
          kind: "contextOperation";
          result: Extract<ContextOperationObservation, { action: "clear" }>;
        }
      : InvocationResult;

/** The control plane owns stable delivery IDs, attempts, todos and capability versions. */
export interface ProviderAdapter<F extends AdapterFamily, Handle extends object> {
  capabilities(instance: AdapterInstance<F>): Promise<AdapterCallResult<CapabilityDeclaration<F>>>;
  open(input: OpenSessionInput<F>): Promise<AdapterCallResult<AdapterSession<F, Handle>>>;
  /** Instance services can run before any coding session exists. */
  invoke<C extends InstanceServiceCommand>(
    instance: AdapterInstance<F>,
    permit: ActionPermit<F, NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
  invoke<C extends AdapterCommand>(
    session: AdapterSession<F, Handle>,
    permit: ActionPermit<F, NoInfer<C["capability"]>>,
    command: C,
  ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
  events(
    session: AdapterSession<F, Handle>,
    after: string | null,
  ): AsyncIterable<AdapterEventEnvelope<F>>;
  close(session: AdapterSession<F, Handle>, reason: CloseReason): Promise<AdapterCallResult<void>>;
}

/** Native IDs can repeat across instances or new connections to the same recording. */
export function matchesAdapterEvent(
  binding: AdapterSessionBinding,
  event: AdapterEventEnvelope,
): boolean {
  return (
    binding.instanceId === event.instanceId &&
    binding.family === event.family &&
    binding.epoch === event.epoch &&
    binding.nativeSessionId === event.sessionId
  );
}

export function validateSessionFamily(
  expected: AdapterFamily,
  session: AdapterSessionBinding,
): AdapterCallResult<void> {
  return session.family === expected
    ? { kind: "ok", value: undefined }
    : { kind: "rejected", reason: "wrongFamily", message: null };
}
