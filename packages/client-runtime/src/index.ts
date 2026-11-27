import type { DeviceSettingsStore } from "./settings";
import type { ReminderLedger } from "./attention";
import type { AttentionHint, AttachmentId, DeviceId, DeviceKeyId } from "@kraka/protocol";

export type ClientRuntimeTarget = "browser" | "electron-main" | "bun";

export type LocalStateMutation = { key: string; value: Uint8Array | null };

/** Cache and cursor changes commit together so an installed cursor never outruns its data. */
export interface LocalStateStore {
  read(key: string): Promise<Uint8Array | null>;
  commit(mutations: readonly LocalStateMutation[]): Promise<void>;
}

export type CreatedDeviceKey = {
  deviceId: DeviceId;
  keyId: DeviceKeyId;
  publicKey: string;
};

/** The host owns private key storage and signs bytes without returning private key material. */
export interface DeviceCredentialProvider {
  /** Reopen and verify the existing key in this environment before signing. */
  discover(
    environmentId: import("@kraka/protocol").EnvironmentId,
  ): Promise<import("./registration").CredentialDiscovery>;
  createDeviceKey(): Promise<CreatedDeviceKey>;
  sign(keyId: DeviceKeyId, message: Uint8Array): Promise<string>;
  removeDeviceKey(keyId: DeviceKeyId): Promise<void>;
}

export interface RandomSource {
  bytes(length: number): Uint8Array;
}

export interface MonotonicClock {
  nowMilliseconds(): number;
}

export type ClientNotification = {
  kind: "todo" | "roundCompleted" | "roundFailed";
  reminder: AttentionHint;
  title: string;
  body: string;
};

export interface NotificationHost {
  show(notification: ClientNotification): Promise<void>;
}

export interface ApplicationLifecycle {
  onForeground(callback: () => void): () => void;
}

export interface AttachmentChunkSource {
  read(attachmentId: AttachmentId, maximumChunkBytes: number): AsyncIterable<Uint8Array>;
}

export interface LinkLauncher {
  open(url: string): Promise<void>;
}

/** Platform-specific ports only. Connection supervision and message handling live elsewhere. */
export interface ClientPlatformCapabilities {
  target: ClientRuntimeTarget;
  desktop?: import("./desktop").DesktopBridge;
  state: LocalStateStore;
  deviceSettings: DeviceSettingsStore;
  credentials: DeviceCredentialProvider;
  random: RandomSource;
  clock: MonotonicClock;
  notifications: NotificationHost;
  reminders: ReminderLedger;
  lifecycle: ApplicationLifecycle;
  attachments: AttachmentChunkSource;
  links: LinkLauncher;
}

export * from "./settings";
export * from "./attention";
export * from "./terminal";
export type { DesktopBridge } from "./desktop";
export type { QueueEditDraft } from "./queue-draft";

export * from "./session";
export * from "./registration";
export * from "./subscription-session";
export * from "./routes";

export { RouteAttempt } from "./route-attempt";
export * from "./thread-pass";

export * from "./thread-installation";
export * from "./thread-replica";
export * from "./tool-activity";
export * from "./setting-storage";
export * from "./setting-batch";
