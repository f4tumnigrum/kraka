import {
  ThreadChangeSchema,
  EarlierSettledRequestSchema,
  EarlierSettledPageSchema,
  ThreadSummarySchema,
} from "./thread-list";
import { TextReturnResultSchema } from "./handoffs";
import { ContextOperationReceiptSchema } from "./context-operations";
import {
  AccessPageRequestSchema,
  AccessChangeSchema,
  UnusedInviteSchema,
} from "./access-management";
import {
  QueueOrderSchema,
  QueuedTargetSchema,
  QueueUpdateSchema,
  QueueConflictSchema,
} from "./queue-changes";
import { PrivateSecretSubmissionSchema, SecretReceiptSchema } from "./private-secrets";
import { DialogueRollbackTargetSchema } from "./checkpoints";
import {
  AppNoteKeySchema,
  AppNoteSchema,
  AppCallbackSchema,
  AppCallbackResultSchema,
  AppConfirmationSchema,
  CheckoutResultSchema,
  ChildLaunchSchema,
  ChildReceiptSchema,
  ChildStatusSchema,
  ChildResultTransferSchema,
} from "./executor-tools";
import {
  GitStatusRequestSchema,
  GitSubscribeSchema,
  GitStatusSchema,
  BrowseWorkspaceSchema,
  ReadWorkspaceFileSchema,
  WorkspaceDirectorySchema,
  WorkspaceFileReadSchema,
  SearchWorkspaceSchema,
  WorkspaceSearchResultSchema,
  WriteWorkspaceFileSchema,
  WorkspaceWriteResultSchema,
} from "./workspace";
import { UpgradeViewSchema, EnvironmentDescriptionSchema, UpgradeRequestSchema } from "./upgrades";
import {
  ForgePublishSchema,
  ForgeProgressSchema,
  ForgeFileKeySchema,
  ForgeMarkRequestSchema,
  ForgeMarkViewSchema,
  ForgeWatchSchema,
  ForgeHistorySchema,
} from "./forge";
import {
  DiffRequestSchema,
  DiffResultSchema,
  RollbackTargetSchema,
  RollbackProgressSchema,
} from "./checkpoints";
import {
  TerminalOpenSchema,
  TerminalAttachSchema,
  TerminalResizeSchema,
  TerminalControlSchema,
  TerminalControlRequestSchema,
  TerminalWriteSchema,
  TerminalDetachSchema,
  TerminalAckSchema,
  TerminalAddressSchema,
  TerminalSessionSchema,
  TerminalInputReceiptSchema,
} from "./terminal";
import {
  WorktreePrepareSchema,
  WorktreeRetrySchema,
  WorktreeCleanSchema,
  WorktreeViewSchema,
  WorktreeRetainedSchema,
} from "./worktrees";
import * as v from "valibot";
import {
  RemoteSettingTargetSchema,
  SettingCheckoutSchema,
  remoteSettings,
  SettingReadSchema,
  SettingWriteSchema,
  SettingReadResultSchema,
  SettingSavedSchema,
  SettingWriteFailureSchema,
} from "./settings";
import {
  AttentionFactsSchema,
  AttentionReadSchema,
  AttentionHistoryResultSchema,
  AttentionObjectResultSchema,
} from "./attention";
import {
  AuthorizationFailureSchema,
  SessionRejectionReasonSchema,
  AuthorizationTargetSchema,
  DeviceKeySchema,
  PermissionGrantSchema,
  PermissionSetSchema,
  P256PublicKeySchema,
  P256SignatureSchema,
  ActivePrincipalSchema,
  DevicePrincipalSchema,
  DEFAULT_DEVICE_PERMISSIONS,
  type PermissionItem,
} from "./access";
import {
  AccessGrantIdSchema,
  ChildTaskIdSchema,
  AttemptIdSchema,
  AttachmentIdSchema,
  CommandIdSchema,
  ConnectionChallengeIdSchema,
  ConnectionIdSchema,
  ContentTransferIdSchema,
  DeliveryIdSchema,
  DeviceIdSchema,
  DeviceKeyIdSchema,
  ExecutorKeyIdSchema,
  PrincipalIdSchema,
  EnvironmentIdSchema,
  EnvironmentSessionIdSchema,
  HistoryAnchorIdSchema,
  MessageIdSchema,
  ObjectVersionSchema,
  PairingClaimIdSchema,
  PairingInviteIdSchema,
  PairingRequestIdSchema,
  ProjectIdSchema,
  RoundIdSchema,
  SubscriptionIdSchema,
  SyncCursorSchema,
  SyncPassIdSchema,
  ThreadIdSchema,
  TodoRequestIdSchema,
  WorktreeIdSchema,
} from "./ids";
import {
  AttachmentReferenceSchema,
  EnvironmentSchema,
  MessageReferenceSchema,
  ObjectKeySchema,
  TodoRequestSchema,
} from "./objects";
import { ExecutorCapabilitiesSchema } from "./executor-capabilities";
import { TransportLimitsSchema } from "./transport-limits";

const unixMilliseconds = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const safeCounter = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const positiveCounter = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
export const ConnectionChallengeSchema = v.pipe(
  v.string(),
  v.minLength(43),
  v.maxLength(43),
  v.regex(/^[A-Za-z0-9_-]+$/),
  v.description("32 random bytes encoded as unpadded base64url."),
);

export const ProtocolVersionSchema = v.strictObject({
  major: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_535)),
  minor: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(65_535)),
});
export type ProtocolVersion = v.InferOutput<typeof ProtocolVersionSchema>;

export const PROTOCOL_FEATURES = [
  "strictSchemas",
  "signedRequests",
  "objectReplacementSync",
  "perStreamFlowControl",
  "binaryContentChunks",
  "privateSecretSubmission",
  "queueEditing",
  "timelineItems",
] as const;
export const ProtocolFeatureSchema = v.picklist(PROTOCOL_FEATURES);
export const ProtocolFeatureSetSchema = v.pipe(
  v.array(ProtocolFeatureSchema),
  v.maxLength(PROTOCOL_FEATURES.length),
);

/** Keys identify a registered device or a signer dedicated to one executor invocation. */
export const RequestSignerSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("device"), deviceId: DeviceIdSchema, keyId: DeviceKeyIdSchema }),
  v.strictObject({
    kind: v.literal("executor"),
    principalId: PrincipalIdSchema,
    keyId: ExecutorKeyIdSchema,
  }),
]);

/** The signer signs canonical UTF-8 JSON of all fields except signature. */
export const ClientAuthenticationSchema = v.pipe(
  v.strictObject({
    kind: v.literal("client.authenticate"),
    protocolVersion: ProtocolVersionSchema,
    environmentId: EnvironmentIdSchema,
    connectionId: ConnectionIdSchema,
    challengeId: ConnectionChallengeIdSchema,
    challenge: ConnectionChallengeSchema,
    clientNonce: ConnectionChallengeSchema,
    signer: RequestSignerSchema,
    sequence: positiveCounter,
    features: ProtocolFeatureSetSchema,
    method: v.literal("session.authenticate"),
    signature: P256SignatureSchema,
  }),
  v.description(
    "Signs the UTF-8 canonical JSON of every field except signature. The server must verify the challenge and client nonce on this connection.",
  ),
);
export type ClientAuthentication = v.InferOutput<typeof ClientAuthenticationSchema>;

export const SessionAuthorizedSchema = v.strictObject({
  kind: v.literal("session.authorized"),
  environmentId: EnvironmentIdSchema,
  connectionId: ConnectionIdSchema,
  environmentSessionId: EnvironmentSessionIdSchema,
  principal: ActivePrincipalSchema,
  signer: RequestSignerSchema,
  authorizedAt: unixMilliseconds,
  protocolVersion: ProtocolVersionSchema,
  features: ProtocolFeatureSetSchema,
});
export type SessionAuthorized = v.InferOutput<typeof SessionAuthorizedSchema>;

export const SessionConfigurationSchema = v.strictObject({
  kind: v.literal("session.configuration"),
  upgrade: v.optional(UpgradeViewSchema),
  description: v.optional(EnvironmentDescriptionSchema),
  connectionId: ConnectionIdSchema,
  environmentSessionId: EnvironmentSessionIdSchema,
  environment: EnvironmentSchema,
  version: ObjectVersionSchema,
  transportLimits: TransportLimitsSchema,
  executors: v.array(ExecutorCapabilitiesSchema),
});
export type SessionConfiguration = v.InferOutput<typeof SessionConfigurationSchema>;

export const SessionRejectedSchema = v.strictObject({
  kind: v.literal("session.rejected"),
  reason: SessionRejectionReasonSchema,
});
export type SessionRejected = v.InferOutput<typeof SessionRejectedSchema>;

export const InputContentSchema = v.strictObject({
  text: v.string(),
  references: v.array(MessageReferenceSchema),
  attachments: v.array(AttachmentReferenceSchema),
});
export type InputContent = v.InferOutput<typeof InputContentSchema>;

export const QuestionAnswerSchema = v.strictObject({
  questionKey: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
  answer: v.pipe(v.string(), v.maxLength(8_192)),
});

export const TodoDecisionSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("approval"),
    choiceKey: v.pipe(v.string(), v.minLength(1), v.maxLength(256)),
    decision: v.picklist(["allow", "deny", "allowEdited"]),
    scope: v.picklist(["once", "session", "project", "persistent"]),
  }),
  v.strictObject({ kind: v.literal("secret"), receiptCommandId: CommandIdSchema }),
]);

export const MethodTargetSchema = v.picklist([
  "environment",
  "project",
  "thread",
  "authorizationTarget",
  "workspace",
  "subscription",
  "attachment",
]);
export type MethodTarget = v.InferOutput<typeof MethodTargetSchema>;

export type RequestMethodDefinition = {
  readonly method: string;
  readonly permission: PermissionItem;
  readonly additionalPermissions?: readonly PermissionItem[];
  readonly target: MethodTarget;
  readonly schema: v.GenericSchema;
};

/** The caller resolves the signed target first; a combined effect must have every listed right on it. */
export function hasMethodPermissions(
  method: RequestMethodDefinition,
  granted: ReadonlySet<PermissionItem>,
): boolean {
  return (
    granted.has(method.permission) &&
    (method.additionalPermissions ?? []).every((right) => granted.has(right))
  );
}

function defineRequestMethod<
  const TMethod extends string,
  const TPermission extends PermissionItem,
  const TTarget extends MethodTarget,
  TPayload extends v.GenericSchema,
>(
  method: TMethod,
  permission: TPermission,
  target: TTarget,
  payload: TPayload,
  additionalPermissions: readonly PermissionItem[] = [],
) {
  const schema = v.pipe(
    v.strictObject({
      kind: v.literal("signedRequest"),
      protocolVersion: ProtocolVersionSchema,
      environmentId: EnvironmentIdSchema,
      connectionId: ConnectionIdSchema,
      challengeId: ConnectionChallengeIdSchema,
      challenge: ConnectionChallengeSchema,
      signer: RequestSignerSchema,
      sequence: positiveCounter,
      commandId: CommandIdSchema,
      method: v.literal(method),
      payload,
      signature: P256SignatureSchema,
    }),
    v.description(
      `Requires ${[permission, ...additionalPermissions].join(" and ")} on ${target}. Sign the UTF-8 JCS canonical JSON of every field except signature with ECDSA P-256 and SHA-256. Reconnect with a fresh challenge and sequence and retain the command ID.`,
    ),
  );
  return { method, permission, additionalPermissions, target, schema } as const;
}

const ThreadStartPayloadSchema = v.strictObject({
  projectId: ProjectIdSchema,
  worktreeId: v.nullable(WorktreeIdSchema),
  content: InputContentSchema,
});
const UploadTargetSchema = v.variant("kind", [
  v.strictObject({ kind: v.literal("project"), projectId: ProjectIdSchema }),
  v.strictObject({ kind: v.literal("thread"), threadId: ThreadIdSchema }),
]);
const SendInputPayloadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  content: InputContentSchema,
});
const SteerInputPayloadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  attemptId: AttemptIdSchema,
  mode: v.picklist(["queueNext", "insertCurrent", "restartCurrent"]),
  content: InputContentSchema,
});
const RoundTargetPayloadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  attemptId: AttemptIdSchema,
});
const TodoTargetPayloadSchema = v.strictObject({
  threadId: ThreadIdSchema,
  todoRequestId: TodoRequestIdSchema,
});
const subscriptionBase = {
  after: v.nullable(SyncCursorSchema),
  recheckTodos: v.array(TodoRequestIdSchema),
};
const ThreadSubscriptionPayloadSchema = v.strictObject({
  subscriptionId: SubscriptionIdSchema,
  streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  threadId: ThreadIdSchema,
  knownWindow: v.array(v.strictObject({ key: ObjectKeySchema, version: ObjectVersionSchema })),
  ...subscriptionBase,
});
const ListSubscriptionPayloadSchema = v.strictObject({
  subscriptionId: SubscriptionIdSchema,
  streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  ...subscriptionBase,
  projectId: v.nullable(ProjectIdSchema),
  windowShapeVersion: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(65_535)),
  knownThreads: v.array(v.strictObject({ threadId: ThreadIdSchema, version: ObjectVersionSchema })),
});
const SubscriptionTargetPayloadSchema = v.strictObject({ subscriptionId: SubscriptionIdSchema });

const confirmationCode = v.pipe(v.string(), v.regex(/^\d{6}$/));
const pageNext = v.nullable(v.pipe(v.string(), v.minLength(1)));
const originalRollback = { threadId: ThreadIdSchema, operationId: CommandIdSchema };
const retryPart = v.strictObject({ ...originalRollback, expectedExecution: positiveCounter });
const parent = { threadId: ThreadIdSchema };
const childTask = { ...parent, taskId: ChildTaskIdSchema };
const appNoteEdit = v.strictObject({
  key: AppNoteKeySchema,
  baseVersion: v.nullable(ObjectVersionSchema),
  text: v.string(),
});

export const REQUEST_METHODS = {
  listGrants: defineRequestMethod(
    "access.listGrants",
    "access.give",
    "authorizationTarget",
    AccessPageRequestSchema,
  ),
  listAccessChanges: defineRequestMethod(
    "access.listChanges",
    "access.give",
    "authorizationTarget",
    AccessPageRequestSchema,
  ),
  listInvites: defineRequestMethod(
    "device.pairing.listInvites",
    "access.give",
    "authorizationTarget",
    AccessPageRequestSchema,
  ),
  listApplications: defineRequestMethod(
    "device.pairing.listApplications",
    "access.give",
    "authorizationTarget",
    v.strictObject({ ...AccessPageRequestSchema.entries, inviteId: PairingInviteIdSchema }),
  ),
  cancelInvite: defineRequestMethod(
    "device.pairing.cancel",
    "access.give",
    "authorizationTarget",
    v.strictObject({ inviteId: PairingInviteIdSchema }),
  ),
  readEarlierSettled: defineRequestMethod(
    "thread.readEarlierSettled",
    "thread.view",
    "authorizationTarget",
    EarlierSettledRequestSchema,
  ),
  changeThreadLifecycle: defineRequestMethod(
    "thread.changeLifecycle",
    "thread.send",
    "thread",
    v.strictObject({ ...parent, baseVersion: ObjectVersionSchema, change: ThreadChangeSchema }),
  ),
  compactThread: defineRequestMethod(
    "thread.compact",
    "thread.send",
    "thread",
    v.strictObject({ threadId: ThreadIdSchema, instructions: v.nullable(v.string()) }),
  ),
  clearThread: defineRequestMethod(
    "thread.clear",
    "thread.send",
    "thread",
    v.strictObject({ threadId: ThreadIdSchema }),
  ),
  editQueued: defineRequestMethod(
    "input.editQueued",
    "thread.send",
    "thread",
    v.strictObject({ ...QueuedTargetSchema.entries, content: InputContentSchema }),
  ),
  cancelQueued: defineRequestMethod(
    "input.cancelQueued",
    "thread.send",
    "thread",
    QueuedTargetSchema,
  ),
  reorderQueue: defineRequestMethod(
    "input.reorderQueue",
    "thread.send",
    "thread",
    QueueOrderSchema,
  ),
  inspectRollback: defineRequestMethod(
    "checkpoint.readRollbackPart",
    "thread.view",
    "thread",
    v.strictObject({ ...originalRollback, part: v.picklist(["dialogue", "files"]) }),
  ),
  retryRollbackDialogue: defineRequestMethod(
    "checkpoint.retryDialogue",
    "thread.send",
    "thread",
    retryPart,
  ),
  retryRollbackFiles: defineRequestMethod(
    "checkpoint.retryFiles",
    "workspace.change",
    "thread",
    retryPart,
  ),
  readGitStatus: defineRequestMethod(
    "git.readStatus",
    "thread.view",
    "workspace",
    GitStatusRequestSchema,
  ),
  subscribeGitStatus: defineRequestMethod(
    "git.subscribeStatus",
    "thread.view",
    "workspace",
    GitSubscribeSchema,
  ),
  browseWorkspace: defineRequestMethod(
    "workspace.list",
    "thread.view",
    "workspace",
    BrowseWorkspaceSchema,
  ),
  readWorkspaceFile: defineRequestMethod(
    "workspace.readFile",
    "thread.view",
    "workspace",
    ReadWorkspaceFileSchema,
  ),
  writeWorkspaceFile: defineRequestMethod(
    "workspace.writeFile",
    "workspace.change",
    "workspace",
    WriteWorkspaceFileSchema,
    ["thread.view"],
  ),
  searchWorkspace: defineRequestMethod(
    "workspace.search",
    "thread.view",
    "workspace",
    SearchWorkspaceSchema,
  ),
  browseHost: defineRequestMethod(
    "host.listDirectory",
    "thread.view",
    "environment",
    v.strictObject({ directory: v.string(), after: pageNext }),
  ),
  openWorkspaceEditor: defineRequestMethod(
    "workspace.openEditor",
    "workspace.change",
    "workspace",
    v.strictObject({
      ...ReadWorkspaceFileSchema.entries,
      line: positiveCounter,
      column: positiveCounter,
    }),
    ["thread.view"],
  ),
  readSecretReceipt: defineRequestMethod(
    "todo.readSecretReceipt",
    "owner.decide",
    "thread",
    v.strictObject({
      ...parent,
      todoRequestId: TodoRequestIdSchema,
      receiptCommandId: CommandIdSchema,
    }),
  ),
  inspectCheckout: defineRequestMethod(
    "thread.inspectCheckout",
    "thread.view",
    "thread",
    v.strictObject(parent),
  ),
  launchChildren: defineRequestMethod(
    "thread.launchChildren",
    "thread.send",
    "thread",
    v.strictObject({
      ...parent,
      mode: v.picklist(["topLevel", "delegate"]),
      items: v.tupleWithRest([ChildLaunchSchema], ChildLaunchSchema),
    }),
  ),
  readChild: defineRequestMethod(
    "thread.readChild",
    "thread.view",
    "thread",
    v.strictObject({ ...childTask, waitMs: v.pipe(safeCounter, v.maxValue(45000)) }),
  ),
  cancelChild: defineRequestMethod(
    "thread.cancelChild",
    "thread.send",
    "thread",
    v.strictObject(childTask),
  ),
  appCallback: defineRequestMethod("app.callback", "thread.view", "thread", AppCallbackSchema),
  confirmAppCallback: defineRequestMethod(
    "app.confirm",
    "owner.decide",
    "thread",
    v.strictObject({ callback: AppCallbackSchema, callbackCommandId: CommandIdSchema }),
  ),
  editAppNote: defineRequestMethod("app.updateNote", "thread.send", "thread", appNoteEdit),

  upgradeEnvironment: defineRequestMethod(
    "environment.upgrade",
    "environment.upgrade",
    "environment",
    UpgradeRequestSchema,
  ),
  publishForge: defineRequestMethod(
    "forge.publish",
    "workspace.change",
    "thread",
    ForgePublishSchema,
  ),
  readForgeOperation: defineRequestMethod(
    "forge.operation",
    "thread.view",
    "thread",
    v.strictObject({ threadId: ThreadIdSchema, operationId: CommandIdSchema }),
  ),
  readForgeFileMark: defineRequestMethod(
    "forge.fileReading",
    "thread.view",
    "thread",
    v.strictObject({ threadId: ThreadIdSchema, file: ForgeFileKeySchema }),
  ),
  markForgeFile: defineRequestMethod(
    "forge.markFile",
    "thread.view",
    "thread",
    ForgeMarkRequestSchema,
  ),
  readForgeHistory: defineRequestMethod(
    "forge.history",
    "thread.view",
    "thread",
    v.strictObject({ watch: ForgeWatchSchema, from: unixMilliseconds, through: unixMilliseconds }),
  ),
  readDiff: defineRequestMethod(
    "checkpoint.diff",
    "thread.view",
    "thread",
    v.strictObject({ query: DiffRequestSchema, cursor: v.nullable(v.string()) }),
  ),
  rollbackDialogue: defineRequestMethod(
    "checkpoint.rollbackDialogue",
    "thread.send",
    "thread",
    DialogueRollbackTargetSchema,
  ),
  restoreFiles: defineRequestMethod(
    "checkpoint.restoreFiles",
    "workspace.change",
    "thread",
    RollbackTargetSchema,
  ),
  rollbackBoth: defineRequestMethod(
    "checkpoint.rollback",
    "thread.send",
    "thread",
    RollbackTargetSchema,
    ["workspace.change"],
  ),
  openTerminal: defineRequestMethod("terminal.open", "term.input", "thread", TerminalOpenSchema),
  attachTerminal: defineRequestMethod(
    "terminal.attach",
    "term.view",
    "thread",
    TerminalAttachSchema,
  ),
  requestTerminalControl: defineRequestMethod(
    "terminal.control",
    "term.input",
    "thread",
    TerminalControlRequestSchema,
  ),
  writeTerminal: defineRequestMethod("terminal.write", "term.input", "thread", TerminalWriteSchema),
  resizeTerminal: defineRequestMethod(
    "terminal.resize",
    "term.view",
    "thread",
    TerminalResizeSchema,
  ),
  ackTerminal: defineRequestMethod("terminal.ack", "term.view", "thread", TerminalAckSchema),
  detachTerminal: defineRequestMethod(
    "terminal.detach",
    "term.view",
    "thread",
    TerminalDetachSchema,
  ),
  closeTerminal: defineRequestMethod(
    "terminal.close",
    "term.input",
    "thread",
    TerminalAddressSchema,
  ),
  prepareWorktree: defineRequestMethod(
    "worktree.prepare",
    "workspace.change",
    "project",
    WorktreePrepareSchema,
  ),
  retryWorktreeSetup: defineRequestMethod(
    "worktree.retrySetup",
    "workspace.change",
    "project",
    WorktreeRetrySchema,
  ),
  cleanWorktree: defineRequestMethod(
    "worktree.clean",
    "workspace.change",
    "project",
    WorktreeCleanSchema,
  ),
  readSetting: defineRequestMethod(
    "settings.read",
    "thread.view",
    "authorizationTarget",
    SettingReadSchema,
  ),
  writeSetting: defineRequestMethod(
    "settings.write",
    "settings.change",
    "authorizationTarget",
    SettingWriteSchema,
  ),
  readAttention: defineRequestMethod(
    "attention.read",
    "thread.view",
    "thread",
    AttentionReadSchema,
  ),
  startThread: defineRequestMethod(
    "thread.start",
    "thread.send",
    "project",
    ThreadStartPayloadSchema,
  ),
  sendInput: defineRequestMethod("input.send", "thread.send", "thread", SendInputPayloadSchema),
  steerInput: defineRequestMethod("input.steer", "thread.send", "thread", SteerInputPayloadSchema),
  releaseQueue: defineRequestMethod(
    "input.releaseQueue",
    "thread.send",
    "thread",
    v.strictObject({ threadId: ThreadIdSchema }),
  ),
  stopRound: defineRequestMethod("round.stop", "thread.send", "thread", RoundTargetPayloadSchema),
  resendUnknownInput: defineRequestMethod(
    "input.resendUnknown",
    "thread.send",
    "thread",
    RoundTargetPayloadSchema,
  ),
  dropUnknownInput: defineRequestMethod(
    "input.dropUnknown",
    "thread.send",
    "thread",
    RoundTargetPayloadSchema,
  ),
  answerTodo: defineRequestMethod(
    "todo.answer",
    "thread.reply",
    "thread",
    v.strictObject({
      ...TodoTargetPayloadSchema.entries,
      answers: v.tupleWithRest([QuestionAnswerSchema], QuestionAnswerSchema),
    }),
  ),
  decideTodo: defineRequestMethod(
    "todo.decide",
    "owner.decide",
    "thread",
    v.strictObject({ ...TodoTargetPayloadSchema.entries, decision: TodoDecisionSchema }),
  ),
  grantAccess: defineRequestMethod(
    "access.grant",
    "access.give",
    "authorizationTarget",
    v.omit(PermissionGrantSchema, ["grantedBy", "id"]),
  ),
  revokeAccess: defineRequestMethod(
    "access.revoke",
    "access.give",
    "authorizationTarget",
    v.strictObject({ grantId: AccessGrantIdSchema }),
  ),
  listSessions: defineRequestMethod(
    "access.listSessions",
    "access.give",
    "environment",
    v.strictObject({}),
  ),
  inviteDevice: defineRequestMethod(
    "device.pairing.invite",
    "access.give",
    "project",
    v.strictObject({ projectId: ProjectIdSchema }),
  ),
  approveDevicePairing: defineRequestMethod(
    "device.pairing.approve",
    "access.give",
    "project",
    v.strictObject({
      requestId: PairingRequestIdSchema,
      confirmationCode,
      permissions: PermissionSetSchema,
    }),
  ),
  revokeDevice: defineRequestMethod(
    "device.revoke",
    "access.give",
    "environment",
    v.strictObject({ deviceId: DeviceIdSchema, deviceKeyId: DeviceKeyIdSchema }),
  ),
  openThreadSubscription: defineRequestMethod(
    "subscription.openThread",
    "thread.view",
    "thread",
    ThreadSubscriptionPayloadSchema,
  ),
  openListSubscription: defineRequestMethod(
    "subscription.openList",
    "thread.view",
    "environment",
    ListSubscriptionPayloadSchema,
  ),
  readHistoryPage: defineRequestMethod(
    "thread.readHistory",
    "thread.view",
    "thread",
    v.strictObject({
      threadId: ThreadIdSchema,
      anchor: v.nullable(HistoryAnchorIdSchema),
      streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
    }),
  ),
  acknowledgeHistoryPage: defineRequestMethod(
    "history.pageSaved",
    "thread.view",
    "thread",
    v.strictObject({
      threadId: ThreadIdSchema,
      anchor: HistoryAnchorIdSchema,
      pageNumber: safeCounter,
    }),
  ),
  closeSubscription: defineRequestMethod(
    "subscription.close",
    "thread.view",
    "subscription",
    SubscriptionTargetPayloadSchema,
  ),
  acknowledgeSavedPage: defineRequestMethod(
    "subscription.pageSaved",
    "thread.view",
    "subscription",
    v.strictObject({
      subscriptionId: SubscriptionIdSchema,
      passId: SyncPassIdSchema,
      pageNumber: safeCounter,
    }),
  ),
  acknowledgeInstalledSnapshot: defineRequestMethod(
    "subscription.installed",
    "thread.view",
    "subscription",
    v.strictObject({
      subscriptionId: SubscriptionIdSchema,
      passId: SyncPassIdSchema,
      cursor: SyncCursorSchema,
    }),
  ),
  reportSubscriptionGap: defineRequestMethod(
    "subscription.gap",
    "thread.view",
    "subscription",
    v.strictObject({ subscriptionId: SubscriptionIdSchema, after: v.nullable(SyncCursorSchema) }),
  ),
  beginAttachmentUpload: defineRequestMethod(
    "attachment.upload",
    "thread.send",
    "authorizationTarget",
    v.strictObject({
      transferId: ContentTransferIdSchema,
      attachmentId: AttachmentIdSchema,
      target: UploadTargetSchema,
      byteLength: safeCounter,
      mediaType: v.pipe(v.string(), v.minLength(1), v.maxLength(128)),
    }),
  ),
  beginAttachmentDownload: defineRequestMethod(
    "attachment.download",
    "thread.view",
    "attachment",
    v.strictObject({
      transferId: ContentTransferIdSchema,
      threadId: ThreadIdSchema,
      attachment: AttachmentReferenceSchema,
      streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
    }),
  ),
} as const satisfies Readonly<Record<string, RequestMethodDefinition>>;

/** Resolve the target and every required permission through the business method, inside the active attempt. */
export const EXECUTOR_TOOL_METHODS = {
  inspectCheckout: REQUEST_METHODS.inspectCheckout,
  sendInput: REQUEST_METHODS.sendInput,
  answerQuestion: REQUEST_METHODS.answerTodo,
  prepareAttachment: REQUEST_METHODS.beginAttachmentUpload,
  launchChildren: REQUEST_METHODS.launchChildren,
  readChild: REQUEST_METHODS.readChild,
  cancelChild: REQUEST_METHODS.cancelChild,
} as const;

const privateSubmit = defineRequestMethod(
  "todo.submitSecret",
  "owner.decide",
  "thread",
  PrivateSecretSubmissionSchema,
);
export const PrivateSecretRequestSchema = v.pipe(
  v.strictObject({
    ...privateSubmit.schema.entries,
    signer: RequestSignerSchema.options[0],
  }),
  v.description(
    "Requires owner.decide on the thread and the negotiated privateSecretSubmission feature. Accepted only by the confidential device handler. Never record or echo its payload in public receipts.",
  ),
);
export const PRIVATE_SECRET_METHOD = {
  ...privateSubmit,
  schema: PrivateSecretRequestSchema,
  requiredFeature: "privateSecretSubmission",
} as const;
export type PrivateSecretRequest = v.InferOutput<typeof PrivateSecretRequestSchema>;
export const requestSchemas = Object.fromEntries(
  Object.values(REQUEST_METHODS).map(({ method, schema }) => [method, schema]),
);

export const SignedRequestSchema = v.variant(
  "method",
  Object.values(REQUEST_METHODS).map((definition) => definition.schema),
);
export type SignedRequest = v.InferOutput<typeof SignedRequestSchema>;

export const PairingRequestSchema = v.pipe(
  v.strictObject({
    kind: v.literal("pairing.request"),
    environmentId: EnvironmentIdSchema,
    inviteId: PairingInviteIdSchema,
    requestId: PairingRequestIdSchema,
    deviceId: DeviceIdSchema,
    publicKey: P256PublicKeySchema,
    target: AuthorizationTargetSchema,
    requestedPermissions: v.optional(PermissionSetSchema, () => [...DEFAULT_DEVICE_PERMISSIONS]),
  }),
  v.description(
    "The default request asks for the nine default permissions. The owner reviews the target and permission list before approval.",
  ),
);
export type PairingRequest = v.InferOutput<typeof PairingRequestSchema>;

/** The environment shows this same summary to the owner and the applicant before approval. */
export const PairingPendingSchema = v.strictObject({
  kind: v.literal("pairing.pending"),
  inviteId: PairingInviteIdSchema,
  environmentId: EnvironmentIdSchema,
  deviceId: DeviceIdSchema,
  publicKey: P256PublicKeySchema,
  target: AuthorizationTargetSchema,
  permissions: PermissionSetSchema,
  requestId: PairingRequestIdSchema,
  confirmationCode,
});

export type PairingPending = v.InferOutput<typeof PairingPendingSchema>;
export const PairingChallengeSchema = v.strictObject({
  kind: v.literal("pairing.challenge"),
  requestId: PairingRequestIdSchema,
  claimId: PairingClaimIdSchema,
  challengeId: ConnectionChallengeIdSchema,
  challenge: ConnectionChallengeSchema,
});

export type PairingChallenge = v.InferOutput<typeof PairingChallengeSchema>;
export const PairingExchangeSchema = v.strictObject({
  kind: v.literal("pairing.exchange"),
  protocolVersion: ProtocolVersionSchema,
  environmentId: EnvironmentIdSchema,
  inviteId: PairingInviteIdSchema,
  requestId: PairingRequestIdSchema,
  claimId: PairingClaimIdSchema,
  deviceId: DeviceIdSchema,
  deviceKeyId: DeviceKeyIdSchema,
  challengeId: ConnectionChallengeIdSchema,
  challenge: ConnectionChallengeSchema,
  sequence: positiveCounter,
  publicKey: P256PublicKeySchema,
  method: v.literal("pairing.exchange"),
  signature: P256SignatureSchema,
});
export type PairingExchange = v.InferOutput<typeof PairingExchangeSchema>;

export const PairingCompletedSchema = v.strictObject({
  kind: v.literal("pairing.completed"),
  requestId: PairingRequestIdSchema,
  principal: DevicePrincipalSchema,
  deviceKey: DeviceKeySchema,
  permissions: PermissionSetSchema,
});

export const PairingRejectedSchema = v.strictObject({
  kind: v.literal("pairing.rejected"),
  requestId: PairingRequestIdSchema,
  reason: v.picklist(["expired", "notSelected", "invalidProof", "cancelled", "alreadyExchanged"]),
});

export const DevicePairingResultSchema = v.variant("kind", [
  PairingCompletedSchema,
  PairingRejectedSchema,
]);

export type DevicePairingResult = v.InferOutput<typeof DevicePairingResultSchema>;
export const RequestResultSchema = v.variant("kind", [
  ContextOperationReceiptSchema,
  TextReturnResultSchema,
  v.strictObject({
    kind: v.literal("grantsListed"),
    grants: v.array(PermissionGrantSchema),
    next: pageNext,
  }),
  v.strictObject({
    kind: v.literal("accessChangesListed"),
    changes: v.array(AccessChangeSchema),
    next: pageNext,
  }),
  v.strictObject({
    kind: v.literal("invitesListed"),
    invites: v.array(UnusedInviteSchema),
    next: pageNext,
  }),
  v.strictObject({
    kind: v.literal("applicationsListed"),
    applications: v.array(PairingPendingSchema),
    next: pageNext,
  }),
  v.strictObject({ kind: v.literal("inviteCancelled"), inviteId: PairingInviteIdSchema }),
  v.strictObject({ kind: v.literal("earlierSettled"), page: EarlierSettledPageSchema }),
  v.strictObject({ kind: v.literal("threadChanged"), summary: ThreadSummarySchema }),
  v.strictObject({ kind: v.literal("queueUpdated"), update: QueueUpdateSchema }),
  v.strictObject({ kind: v.literal("gitStatus"), snapshot: GitStatusSchema }),
  v.strictObject({ kind: v.literal("directoryListed"), directory: WorkspaceDirectorySchema }),
  v.strictObject({ kind: v.literal("fileRead"), file: WorkspaceFileReadSchema }),
  v.strictObject({ kind: v.literal("fileWritten"), write: WorkspaceWriteResultSchema }),
  v.strictObject({ kind: v.literal("workspaceMatches"), search: WorkspaceSearchResultSchema }),
  v.strictObject({ kind: v.literal("secretReceipt"), receipt: SecretReceiptSchema }),
  v.strictObject({ kind: v.literal("checkoutObserved"), checkout: CheckoutResultSchema }),
  v.strictObject({ kind: v.literal("childrenAccepted"), items: v.array(ChildReceiptSchema) }),
  v.strictObject({ kind: v.literal("childStatus"), child: ChildStatusSchema }),
  v.strictObject({ kind: v.literal("childResultTransfer"), transfer: ChildResultTransferSchema }),
  v.strictObject({ kind: v.literal("appCallback"), result: AppCallbackResultSchema }),
  v.strictObject({ kind: v.literal("appConfirmed"), confirmation: AppConfirmationSchema }),
  v.strictObject({ kind: v.literal("appNoteChanged"), note: AppNoteSchema }),

  v.strictObject({ kind: v.literal("forgeOperation"), operation: ForgeProgressSchema }),
  v.strictObject({ kind: v.literal("forgeFileReading"), reading: ForgeMarkViewSchema }),
  v.strictObject({ kind: v.literal("forgeHistory"), history: v.array(ForgeHistorySchema) }),
  v.strictObject({ kind: v.literal("checkpointDiff"), diff: DiffResultSchema }),
  v.strictObject({ kind: v.literal("checkpointRollback"), progress: RollbackProgressSchema }),
  v.strictObject({ kind: v.literal("terminalControl"), control: TerminalControlSchema }),
  v.strictObject({ kind: v.literal("terminalSession"), session: TerminalSessionSchema }),
  v.strictObject({ kind: v.literal("terminalInput"), receipt: TerminalInputReceiptSchema }),
  v.strictObject({ kind: v.literal("worktreeStatus"), view: WorktreeViewSchema }),
  v.strictObject({
    kind: v.literal("worktreeRetained"),
    view: WorktreeViewSchema,
    reason: WorktreeRetainedSchema,
  }),
  SettingReadResultSchema,
  SettingSavedSchema,
  AttentionHistoryResultSchema,
  AttentionObjectResultSchema,
  v.strictObject({ kind: v.literal("attentionFacts"), facts: AttentionFactsSchema }),
  v.strictObject({
    kind: v.literal("threadStarted"),
    threadId: ThreadIdSchema,
    messageId: MessageIdSchema,
    roundId: RoundIdSchema,
    attemptId: AttemptIdSchema,
    deliveryId: DeliveryIdSchema,
  }),
  v.strictObject({
    kind: v.literal("inputScheduled"),
    messageId: MessageIdSchema,
    roundId: RoundIdSchema,
    attemptId: AttemptIdSchema,
    deliveryId: DeliveryIdSchema,
  }),
  v.strictObject({
    kind: v.literal("actionAccepted"),
    supportedFields: v.optional(v.array(v.string())),
  }),
  v.strictObject({ kind: v.literal("todoAnswerStored"), todoRequestId: TodoRequestIdSchema }),
  v.strictObject({ kind: v.literal("accessChanged"), grantId: AccessGrantIdSchema }),
  v.strictObject({
    kind: v.literal("pairingInvited"),
    inviteId: PairingInviteIdSchema,
    expiresAt: unixMilliseconds,
  }),
  v.strictObject({
    kind: v.literal("sessionsListed"),
    sessions: v.array(
      v.strictObject({
        sessionId: EnvironmentSessionIdSchema,
        connectionId: ConnectionIdSchema,
        principal: ActivePrincipalSchema,
        signer: RequestSignerSchema,
        authorizedAt: unixMilliseconds,
      }),
    ),
  }),
  v.strictObject({
    kind: v.literal("subscriptionOpened"),
    subscriptionId: SubscriptionIdSchema,
    streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  }),
  v.strictObject({
    kind: v.literal("contentTransferOpened"),
    transferId: ContentTransferIdSchema,
    streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  }),
  v.strictObject({
    kind: v.literal("historyReadStarted"),
    streamId: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(2_147_483_647)),
  }),
]);
export type RequestResult = v.InferOutput<typeof RequestResultSchema>;

export const CommandReceiptSchema = v.variant("kind", [
  v.strictObject({
    kind: v.literal("accepted"),
    commandId: CommandIdSchema,
    result: RequestResultSchema,
  }),
  v.strictObject({
    kind: v.literal("rejected"),
    commandId: CommandIdSchema,
    failure: v.union([
      AuthorizationFailureSchema,
      QueueConflictSchema,
      v.strictObject({
        kind: v.literal("threadVersionConflict"),
        threadId: ThreadIdSchema,
        currentVersion: ObjectVersionSchema,
      }),
      SettingWriteFailureSchema,
      v.strictObject({ kind: v.literal("todoChanged"), current: TodoRequestSchema }),
      v.strictObject({
        kind: v.picklist([
          "unsupported",
          "notFound",
          "crossRepository",
          "invalidState",
          "idConflict",
          "expired",
          "unsafeToRetry",
          "cursorExpired",
          "staleSequence",
          "invalidProof",
        ]),
      }),
    ]),
  }),
  v.strictObject({
    kind: v.literal("programError"),
    commandId: CommandIdSchema,
    code: v.literal("internalError"),
  }),
]);
export type CommandReceipt = v.InferOutput<typeof CommandReceiptSchema>;

/** Decode old acknowledgements through the same strict receipt schema as current frames. */
export function readSettingWriteReceipt(raw: unknown): CommandReceipt | null {
  const result = v.safeParse(CommandReceiptSchema, raw);
  return result.success ? result.output : null;
}

const unknownSettingPayload = v.strictObject({
  field: v.pipe(v.string(), v.minLength(1)),
  target: RemoteSettingTargetSchema,
  checkout: v.nullable(SettingCheckoutSchema),
  baseVersion: ObjectVersionSchema,
  change: v.variant("kind", [
    v.strictObject({ kind: v.literal("absent") }),
    v.strictObject({ kind: v.literal("set"), value: v.unknown() }),
  ]),
});

/** Used after signature and target checks. Only an unknown name earns an unsupported-field receipt. */
export function readSettingWritePayload(
  commandId: v.InferOutput<typeof CommandIdSchema>,
  raw: unknown,
) {
  const current = v.safeParse(SettingWriteSchema, raw);
  if (current.success) return { kind: "known" as const, edit: current.output };
  const other = v.safeParse(unknownSettingPayload, raw);
  if (!other.success || remoteSettings.some((def) => def.name === other.output.field))
    return { kind: "invalid" as const };
  const { field, target, checkout } = other.output;
  const receipt = {
    kind: "rejected",
    commandId,
    failure: {
      kind: "unrecognizedSetting",
      field,
      target,
      checkout,
      supportedFields: remoteSettings.map((d) => d.name),
    },
  } satisfies CommandReceipt;
  return { kind: "unrecognized" as const, receipt };
}

/** The confidential ingress checks this result before retaining any payload. Invalid values never appear in diagnostics. */
export function readPrivateSecretRequest(
  raw: unknown,
  features: readonly v.InferOutput<typeof ProtocolFeatureSchema>[],
) {
  if (!features.includes(PRIVATE_SECRET_METHOD.requiredFeature))
    return { kind: "unsupported" } as const;
  const parsed = v.safeParse(PrivateSecretRequestSchema, raw);
  return parsed.success &&
    parsed.output.environmentId === parsed.output.payload.target.environmentId
    ? { kind: "request" as const, request: parsed.output }
    : { kind: "invalid" as const };
}
