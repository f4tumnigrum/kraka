import type {
  AttemptId,
  AppNote,
  AppNoteRead,
  AttachmentReference,
  CommandId,
  DeliveryId,
  HandoffContext,
  DelegatedChildRecord,
  ChildResultTransfer,
  MessageId,
  EnvironmentSessionId,
  ExecutorInstanceSnapshot,
  MessageReference,
  ObjectVersion,
  PrincipalId,
  ThreadId,
} from "@kraka/protocol";
import type {
  AdapterInstance,
  AdapterSessionBinding,
  AdapterInput,
  CapabilityDeclaration,
  SessionSetup,
  Readiness,
} from "./adapter-contract";

/** Only the environment resolves this reference to secret material. */
export type CredentialBinding = {
  ownerId: PrincipalId;
  namespace: string;
  key: string;
  version: ObjectVersion;
};
export type ExecutorRegistration = AdapterInstance & {
  version: ObjectVersion;
  displayName: string;
  enabled: boolean;
  driver: {
    executable: string | null;
    args?: readonly string[] | undefined;
    endpoint: string | null;
    configurationRoot: string | null;
    historyRoot: string | null;
    variables: Readonly<
      Record<
        string,
        { kind: "literal"; value: string } | { kind: "secret"; binding: CredentialBinding }
      >
    >;
  };
  credential: CredentialBinding | null;
  model: SessionSetup["model"] | null;
  permission: SessionSetup["permission"];
};
export type InstanceProbe = AdapterInstance & {
  configurationVersion: ObjectVersion;
  credential: CredentialBinding | null;
  workingDirectory: string | null;
  model: SessionSetup["model"] | null;
  binaryVersion: string | null;
  declaration: CapabilityDeclaration;
};
/** Store the probe and publish its snapshot only while the configuration and credential binding still match. */
export interface ExecutorRegistry {
  read(instanceId: AdapterInstance["instanceId"]): Promise<ExecutorRegistration | null>;
  save(registration: ExecutorRegistration, expectedVersion: ObjectVersion | null): Promise<boolean>;
  readProbe(instanceId: AdapterInstance["instanceId"]): Promise<InstanceProbe | null>;
  snapshot(instanceId: AdapterInstance["instanceId"]): Promise<ExecutorInstanceSnapshot | null>;
  /** Derive the published view from this declaration and the matching registration, or discard a stale probe. */
  publish(probe: InstanceProbe): Promise<ExecutorInstanceSnapshot | null>;
}

export type LoginFlow = {
  flowId: CommandId;
  instanceId: AdapterInstance["instanceId"];
  credential: CredentialBinding | null;
  ownerSessionId: EnvironmentSessionId;
  expiresAt: number;
};
export type LoginStatus =
  | { kind: "browser"; url: string }
  | { kind: "deviceCode"; url: string; userCode: string }
  | { kind: "nativeCli"; instructions: string }
  | { kind: "verifying" }
  | { kind: "authenticated"; account: string }
  | { kind: "failed"; reason: string }
  | { kind: "cancelled" | "expired" };
/** Interaction details belong only to the initiating device session. A callback still requires account verification. */
export type LoginResult = LoginFlow & { status: LoginStatus };
export type AuthenticationResult = { status: Readiness; account: string | null };
export type ModelOption =
  | { kind: "enum"; values: readonly string[] }
  | { kind: "boolean" | "number" | "string" };
export type ModelCatalog = {
  checkedAt: number;
  models: readonly {
    id: string;
    displayName: string;
    slug: string;
    isDefault: boolean;
    unavailableReason?: string | undefined;
    options: Readonly<Record<string, ModelOption>>;
  }[];
};

/** One current binding per thread. Preserve the previous binding in history in the same conditional write. */
export type ThreadSessionBinding = AdapterSessionBinding & {
  threadId: ThreadId;
  attemptId: AttemptId;
};
export interface ThreadBindingStore {
  current(threadId: ThreadId): Promise<ThreadSessionBinding | null>;
  history(threadId: ThreadId): Promise<readonly ThreadSessionBinding[]>;
  /** Match the full current identity, keep the thread, and advance its epoch when replacing a binding. */
  replace(expected: ThreadSessionBinding | null, next: ThreadSessionBinding): Promise<boolean>;
}

type FrozenSource =
  | { kind: "reference"; reference: MessageReference }
  | { kind: "attachment"; attachment: AttachmentReference };
type DeliveredPart = FrozenSource & {
  carrier:
    | { kind: "inlineText"; text: string }
    | { kind: "bytes"; digest: string; byteLength: number }
    | { kind: "executorPath"; path: string; digest: string | null }
    | { kind: "marker"; text: string }
    | { kind: "omitted"; reason: string };
};
/** Retain immutable content by digest for byte carriers. A path records what was sent, never proof of a read. */
export type FrozenDelivery = {
  deliveryId: DeliveryId;
  attemptId: AttemptId;
  target: AdapterSessionBinding;
  messageVersion: ObjectVersion;
  input: AdapterInput;
  parts: readonly DeliveredPart[];
  appNotes?: AppNoteRead;
  handoff?: HandoffContext;
};
export interface DeliveryStore {
  read(deliveryId: DeliveryId): Promise<FrozenDelivery | null>;
  /** Compare the entire frozen record on retry. A conflict must leave the original intact. */
  record(delivery: FrozenDelivery): Promise<"stored" | "unchanged" | "conflict">;
}

/** Child completion and its pending parent return are committed as one durable result. */
export interface ChildResultTransferStore {
  read(taskId: DelegatedChildRecord["taskId"]): Promise<DelegatedChildRecord | null>;
  readTransfer(transferId: ChildResultTransfer["id"]): Promise<ChildResultTransfer | null>;
  settle(
    record: DelegatedChildRecord,
    transfer: ChildResultTransfer,
  ): Promise<"stored" | "unchanged" | "conflict">;
  markReturned(
    transferId: ChildResultTransfer["id"],
    parentMessageId: MessageId,
    returnedAt: number,
    expectedVersion: ChildResultTransfer["version"],
  ): Promise<"returned" | "unchanged" | "conflict">;
}

/** An empty edit writes a versioned tombstone. A failed read is frozen and reported with this same delivery. */
export interface AppNoteStore {
  replace(note: AppNote, expectedVersion: ObjectVersion | null): Promise<"saved" | "conflict">;
  read(threadId: ThreadId, deliveryId: DeliveryId): Promise<AppNoteRead>;
}
