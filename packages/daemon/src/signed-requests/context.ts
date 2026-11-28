import type {
  CommandId,
  CommandReceipt,
  FlowPeer,
  InboundSettingWrite,
  PermissionItem,
  PrivateSecretRequest,
  SessionAuthorized,
  SignedRequest,
  ThreadId,
} from "@kraka/protocol";
import type { FirstSendStore, LocalActor, StopCommand } from "@kraka/environment";
import type { openAccessHost } from "../access";
import type { ThreadSubscriptions } from "../thread-subscriptions";
import type { GitStatusSubscriptions } from "../git-status-subscriptions";
import type { FixtureSettingReply, FixtureThreadCommand } from "../thread-connection";
import type { watchSettings } from "./settings";
import type { LocalDiffService } from "@kraka/environment";
export type Request = SignedRequest | InboundSettingWrite | PrivateSecretRequest;
export type Handler<M extends Request["method"]> = (
  request: Extract<Request, { method: M }>,
  context: RequestContext,
) => CommandReceipt | null | void;
export interface RequestContext {
  store: FirstSendStore;
  accountQuota: import("../account-quota").AccountQuota | undefined;
  quotaViews: Map<string, () => void>;
  allowsEnvironmentView(): boolean;
  quotaSignal(): AbortSignal;
  executors: import("../executor-instances").ExecutorInstances;
  startThread: (
    actor: LocalActor,
    req: Extract<SignedRequest, { method: "thread.start" }>,
  ) => Promise<CommandReceipt>;
  loginSession: import("../instance-login").LoginSession;
  host: Awaited<ReturnType<typeof openAccessHost>>;
  principal: LocalActor;
  deviceId: Extract<SessionAuthorized["signer"], { kind: "device" }>["deviceId"];
  session: SessionAuthorized;
  subs: ThreadSubscriptions;
  gitStatus: GitStatusSubscriptions;
  peer: FlowPeer;
  wake(): void;
  active(): boolean;
  diffService: LocalDiffService;
  visibility(): string;
  allows(thread: ThreadId, permission: PermissionItem): boolean;
  disclose(result: CommandReceipt, allowed: () => boolean): void;
  disclosures: Map<CommandId, { stream: number | undefined; allowed: () => boolean }>;
  failed(commandId: CommandId): void;
  schedule(thread: ThreadId, command: CommandId): void;
  sendInput(
    actor: LocalActor,
    req: Extract<SignedRequest, { method: "input.send" }>,
  ): Promise<CommandReceipt>;
  stopCommand: ((actor: LocalActor, cmd: StopCommand) => CommandReceipt) | undefined;
  steerCommand:
    | ((
        actor: LocalActor,
        cmd: Extract<SignedRequest, { method: "input.steer" }>,
      ) => CommandReceipt)
    | undefined;
  settingReply: FixtureSettingReply | undefined;
  watch: ReturnType<typeof watchSettings>;
  fixtureCommand: FixtureThreadCommand | undefined;
  beforeTodo: ((id: CommandId, proceed: () => void) => void) | undefined;
  beforeInputReceipt:
    | ((request: SignedRequest, receipt: CommandReceipt, deliver: () => void) => void)
    | undefined;
}
