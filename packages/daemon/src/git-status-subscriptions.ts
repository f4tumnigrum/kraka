import {
  workspaceAuthorizationTarget,
  type CommandId,
  type CommandReceipt,
  type FlowPeer,
  type SignedRequest,
  type SubscriptionId,
  type WorkspaceTargetSchema,
} from "@kraka/protocol";
import {
  type GitStatusCache,
  resolveWorkspaceTarget,
  readAuthorizedGitStatus,
  type FirstSendStore,
} from "@kraka/environment";
import type * as v from "valibot";
import { GitStatusStream } from "./git-status-stream";

type WorkspaceTarget = v.InferOutput<typeof WorkspaceTargetSchema>;
type StatusSubscription = {
  target: WorkspaceTarget;
  granularity: "branch" | "detailed";
  stream: GitStatusStream;
  releaseCache: () => void;
  lastSequence: number;
};

export class GitStatusSubscriptions {
  private readonly subscriptions = new Map<SubscriptionId, StatusSubscription>();
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(
    private readonly peer: FlowPeer,
    private readonly wake: () => void,
    private readonly store: FirstSendStore,
    private readonly environmentId: string,
    private readonly canRead: (target: WorkspaceTarget) => boolean,
    private readonly cache: GitStatusCache,
    private readonly threadSubscriptionExists: (id: SubscriptionId) => boolean,
  ) {
    this.timer = setInterval(() => this.refresh(), 250);
    this.timer.unref();
  }

  has(id: SubscriptionId) {
    return this.subscriptions.has(id);
  }

  handle(req: SignedRequest): CommandReceipt | null {
    if (req.method === "git.readStatus") {
      const { commandId } = req;
      if (!this.canRead(req.payload.target)) return this.denied(commandId, req.payload.target);
      const snapshot = readAuthorizedGitStatus({
        store: this.store,
        cache: this.cache,
        environmentId: this.environmentId,
        target: req.payload.target,
        granularity: req.payload.granularity,
      });
      return {
        kind: "accepted",
        commandId,
        result: { kind: "gitStatus", snapshot },
      };
    }
    if (req.method === "git.subscribeStatus") {
      const { commandId } = req,
        { target, granularity, subscriptionId, streamId } = req.payload;
      if (!this.canRead(target)) return this.denied(commandId, target);
      if (this.subscriptions.has(subscriptionId) || this.threadSubscriptionExists(subscriptionId))
        return this.rejected(commandId, "invalidState");
      const stream = new GitStatusStream(this.peer, subscriptionId, this.wake, () => {
        this.subscriptions.get(subscriptionId)?.releaseCache();
        this.subscriptions.delete(subscriptionId);
      });
      if (stream.id !== streamId) {
        stream.end("clientClosed");
        return this.rejected(commandId, "invalidState");
      }
      const releaseCache = this.cache.watch(
        {
          environmentId: this.environmentId,
          target,
          granularity,
        },
        resolveWorkspaceTarget(this.store, target)?.directory ?? null,
      );
      this.subscriptions.set(subscriptionId, {
        target,
        granularity,
        stream,
        releaseCache,
        lastSequence: 0,
      });
      queueMicrotask(() => this.refreshOne(subscriptionId));
      return {
        kind: "accepted",
        commandId,
        result: { kind: "subscriptionOpened", subscriptionId, streamId },
      };
    }
    if (req.method === "subscription.close" || req.method === "subscription.gap") {
      const subscription = this.subscriptions.get(req.payload.subscriptionId);
      if (!subscription) return null;
      if (!this.canRead(subscription.target)) {
        this.end(subscription, "authorizationRevoked");
        return this.rejected(req.commandId, "notFound");
      }
      this.end(subscription, "clientClosed");
      return {
        kind: "accepted",
        commandId: req.commandId,
        result: { kind: "actionAccepted" },
      };
    }
    return null;
  }

  recheckAccess() {
    for (const subscription of this.subscriptions.values())
      if (!this.canRead(subscription.target)) this.end(subscription, "authorizationRevoked");
  }

  close() {
    clearInterval(this.timer);
    for (const subscription of this.subscriptions.values()) this.end(subscription, "clientClosed");
  }

  private refresh() {
    for (const id of this.subscriptions.keys()) this.refreshOne(id);
  }

  private refreshOne(id: SubscriptionId) {
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    if (!this.canRead(subscription.target)) {
      this.end(subscription, "authorizationRevoked");
      return;
    }
    const snapshot = readAuthorizedGitStatus({
      store: this.store,
      cache: this.cache,
      environmentId: this.environmentId,
      target: subscription.target,
      granularity: subscription.granularity,
    });
    if (snapshot.sequence === subscription.lastSequence) return;
    subscription.lastSequence = snapshot.sequence;
    subscription.stream.publish(snapshot);
  }

  private end(subscription: StatusSubscription, reason: "authorizationRevoked" | "clientClosed") {
    this.peer.send.withdraw(subscription.stream.id);
    subscription.stream.end(reason);
  }

  private denied(commandId: CommandId, target: WorkspaceTarget): CommandReceipt {
    return {
      kind: "rejected",
      commandId,
      failure: {
        kind: "missingPermission",
        permission: "thread.view",
        target: workspaceAuthorizationTarget(target),
      },
    };
  }

  private rejected(commandId: CommandId, kind: "invalidState" | "notFound"): CommandReceipt {
    return { kind: "rejected", commandId, failure: { kind } };
  }
}
