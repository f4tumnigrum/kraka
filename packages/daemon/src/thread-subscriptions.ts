import * as v from "valibot";
import {
  binarySource,
  ContentTransferIdSchema,
  SyncPassIdSchema,
  SubscriptionIdSchema,
  TRANSPORT_LIMITS,
  wireBytes,
  sameHead,
  type CommandReceipt,
  type FlowPeer,
  type HistoryPage,
  type PrincipalId,
  type TodoRequest,
  type ProjectId,
  type SignedRequest,
  type SubscriptionId,
  type SubscriptionPage,
  type ThreadId,
} from "@kraka/protocol";
import {
  planThreadPass,
  planListPass,
  earlierSettledPage,
  type ListOpen,
  type FirstSendStore,
  type AuthorizedScope,
  type ThreadOpen,
} from "@kraka/environment";
import { SubscriptionWriter } from "./subscription-writer";

type Plan = Extract<ReturnType<typeof planThreadPass>, { kind: "pass" }>;
type Sub = {
  open: ThreadOpen | ListOpen;
  writer: SubscriptionWriter;
  off: () => void;
  dirty: boolean;
  flight: { plan: Plan; id: SubscriptionPage["passId"]; count: number } | null;
};
type Access = {
  principal: PrincipalId;
  canList: (id: ProjectId | null) => boolean;
  canAnswer: (todo: TodoRequest) => boolean;
  visibility: () => string;
  canRead: (thread: ThreadId) => boolean;
  timelineItems: boolean;
  protocolMinor: number;
};
export class ThreadSubscriptions {
  private subs = new Map<SubscriptionId, Sub>();
  private histories = new Map<number, HistoryPage>();
  constructor(
    private peer: FlowPeer,
    private wake: () => void,
    private store: FirstSendStore,
    private access: Access,
    private inspectPage?: (page: SubscriptionPage) => SubscriptionPage,
  ) {}
  private scope(threadId: ThreadId): AuthorizedScope {
    const permissions = new Map<ThreadId, boolean>();
    return {
      threadId,
      environmentId: this.store.writer.environmentId,
      canRead: (id) => {
        const old = permissions.get(id);
        if (old !== undefined) return old;
        const granted = this.access.canRead(id);
        permissions.set(id, granted);
        return granted;
      },
      timelineItems: this.access.timelineItems,
      protocolMinor: this.access.protocolMinor,
    };
  }
  private allowed(open: Sub["open"]) {
    return "threadId" in open
      ? this.access.canRead(open.threadId)
      : this.access.canList(open.projectId);
  }
  private list(projectId: ProjectId | null) {
    return this.store.sync.readList(
      { kind: "list", projectId },
      this.access.visibility(),
      this.access.principal,
      this.access.canRead,
      this.access.canAnswer,
    );
  }
  recheckAccess() {
    const visibility = this.access.visibility();
    for (const s of this.subs.values()) {
      if (!this.allowed(s.open)) {
        this.peer.send.withdraw(s.writer.id);
        this.end(s, "authorizationRevoked");
        continue;
      }
      const head = s.flight?.plan.through ?? s.open.after;
      if (head && head.visibilityGeneration !== visibility) {
        this.peer.send.withdraw(s.writer.id);
        this.peer.control({
          kind: "subscription.reset",
          subscriptionId: s.open.subscriptionId,
          reason: "authorizationChanged",
        });
        this.end(s, "clientClosed");
      }
    }
    for (const [id, page] of this.histories)
      if (
        page.verifiedAt.visibilityGeneration !== visibility ||
        !this.access.canRead(page.threadId)
      ) {
        this.peer.send.withdraw(id);
        this.peer.send.end(id, "authorizationRevoked");
        this.histories.delete(id);
      }
  }
  private end(s: Sub, reason: "clientClosed" | "authorizationRevoked" | "backlogExceeded") {
    s.off();
    this.subs.delete(s.open.subscriptionId);
    this.peer.send.end(s.writer.id, reason);
    this.wake();
  }
  private advance(s: Sub) {
    if (!this.allowed(s.open)) {
      this.end(s, "authorizationRevoked");
      return;
    }
    if (s.flight || !s.dirty) return;
    s.dirty = false;
    const open = s.open;
    const plan =
      "threadId" in open
        ? this.threadPlan(open)
        : planListPass({
            actor: this.access.principal,
            scope: { kind: "list", projectId: open.projectId },
            knownThreads: open.knownThreads,
            base: open.after,
            readView: this.list(open.projectId),
            recheckTodos: open.recheckTodos,
          });
    if (plan.kind === "reset") {
      this.peer.control({
        kind: "subscription.reset",
        subscriptionId: s.open.subscriptionId,
        reason: plan.reason,
      });
      this.end(s, "clientClosed");
      return;
    }
    if (plan.kind !== "pass") {
      this.end(s, "authorizationRevoked");
      return;
    }
    const id = v.parse(SyncPassIdSchema, crypto.randomUUID());
    const parts: SubscriptionPage["changes"][] = [];
    let part: SubscriptionPage["changes"] = [],
      bytes = 0;
    for (const change of plan.changes) {
      const n = Buffer.byteLength(JSON.stringify(change));
      if (part.length && bytes + n > 16384) {
        parts.push(part);
        part = [];
        bytes = 0;
      }
      part.push(change);
      bytes += n;
    }
    if (part.length) parts.push(part);
    if (parts.length > 65536) {
      this.end(s, "backlogExceeded");
      return;
    }
    const subscriptionId = s.open.subscriptionId;
    const begin = {
      kind: "subscription.begin" as const,
      subscriptionId,
      passId: id,
      base: plan.base,
      through: plan.through,
      mode: plan.mode,
    };
    s.flight = { plan, id, count: parts.length };
    if (
      !s.writer.offer({
        begin,
        pages: parts.map((changes, pageNumber) => {
          const page: SubscriptionPage = {
            kind: "subscription.page",
            subscriptionId,
            passId: id,
            through: plan.through,
            pageNumber,
            pageCount: parts.length,
            changes,
          };
          return this.inspectPage?.(page) ?? page;
        }),
      })
    )
      this.end(s, "backlogExceeded");
  }
  private threadPlan(open: ThreadOpen) {
    const scope = this.scope(open.threadId);
    return planThreadPass({
      ...open,
      authorizedScope: scope,
      readView: this.store.sync.read(scope, this.access.visibility()),
    });
  }
  handle(req: SignedRequest): CommandReceipt | null {
    const commandId = req.commandId;
    const accepted = (
      result: Extract<CommandReceipt, { kind: "accepted" }>["result"],
    ): CommandReceipt => ({ kind: "accepted", commandId, result });
    const rejected = (kind: "invalidState" | "notFound"): CommandReceipt => ({
      kind: "rejected",
      commandId,
      failure: { kind },
    });
    switch (req.method) {
      case "thread.readEarlierSettled": {
        const { target, after } = req.payload;
        if (target.kind === "environment" && target.environmentId !== req.environmentId)
          return rejected("invalidState");
        const project = target.kind === "project" ? target.projectId : null;
        if (!this.access.canList(project)) return rejected("notFound");
        const page = earlierSettledPage(this.list(project), after);
        return page ? accepted({ kind: "earlierSettled", page }) : rejected("invalidState");
      }
      case "subscription.openList":
      case "subscription.openThread": {
        const open = req.payload;
        if (
          open.after?.environmentId !== undefined &&
          open.after.environmentId !== req.environmentId
        )
          return rejected("invalidState");
        if (this.subs.has(open.subscriptionId) || !this.allowed(open)) return rejected("notFound");
        const writer = new SubscriptionWriter(this.peer, open.subscriptionId, this.wake);
        if (writer.id !== open.streamId) {
          writer.end("clientClosed");
          return rejected("invalidState");
        }
        const s: Sub = { open, writer, off: () => {}, dirty: true, flight: null };
        this.subs.set(open.subscriptionId, s);
        s.off = this.store.sync.subscribe(() => {
          s.dirty = true;
          if (!s.flight)
            queueMicrotask(() => {
              if (this.subs.get(open.subscriptionId) === s) this.advance(s);
            });
        });
        // Queue the receipt before any begin, page, or reset from this view.
        queueMicrotask(() => {
          if (this.subs.get(open.subscriptionId) === s) this.advance(s);
        });
        return accepted({
          kind: "subscriptionOpened",
          subscriptionId: open.subscriptionId,
          streamId: writer.id,
        });
      }
      case "subscription.close":
      case "subscription.gap":
      case "subscription.pageSaved":
      case "subscription.installed": {
        const sub = this.subs.get(req.payload.subscriptionId);
        if (!sub) return rejected("notFound");
        if (!this.allowed(sub.open)) {
          this.end(sub, "authorizationRevoked");
          return rejected("notFound");
        }
        if (req.method === "subscription.gap" || req.method === "subscription.close") {
          this.end(sub, "clientClosed");
          return accepted({ kind: "actionAccepted" });
        }
        const flight = sub.flight;
        if (!flight || flight.id !== req.payload.passId) return rejected("invalidState");
        if (req.method === "subscription.installed") {
          if (!sameHead(req.payload.cursor, flight.plan.through)) return rejected("invalidState");
          sub.open =
            "knownThreads" in sub.open
              ? {
                  ...sub.open,
                  after: flight.plan.through,
                  recheckTodos: [],
                  knownThreads: flight.plan.members.flatMap(({ key, version }) =>
                    key.objectType === "thread" ? [{ threadId: key.id, version }] : [],
                  ),
                }
              : {
                  ...sub.open,
                  after: flight.plan.through,
                  knownWindow: flight.plan.members,
                  recheckTodos: [],
                };
          sub.flight = null;
          if (sub.dirty)
            queueMicrotask(() => {
              if (this.subs.get(sub.open.subscriptionId) === sub) this.advance(sub);
            });
        } else if (req.payload.pageNumber >= flight.count) return rejected("invalidState");
        return accepted({ kind: "actionAccepted" });
      }
      case "thread.readHistory": {
        const { threadId, anchor, streamId } = req.payload;
        const scope = this.scope(threadId),
          visibility = this.access.visibility();
        const page = this.store.sync.history(scope, visibility, this.access.principal, anchor);
        if (!page) return rejected("notFound");
        const data = this.peer.port.utf8.encode(JSON.stringify(page));
        const transferId = v.parse(ContentTransferIdSchema, crypto.randomUUID());
        let declared = false,
          finished = false;
        const chunk = binarySource({
          epoch: this.peer.epoch,
          streamId,
          transferId,
          length: data.length,
          utf8: this.peer.port.utf8,
          read: (off, n) => data.subarray(off, off + n),
        });
        const id = this.peer.send.open(
          v.parse(SubscriptionIdSchema, page.anchor),
          (offset, capacity) => {
            if (finished) return null;
            if (
              visibility !== this.access.visibility() ||
              !scope.canRead(threadId) ||
              page.rows.some((row) => "threadId" in row.value && !scope.canRead(row.value.threadId))
            ) {
              this.peer.send.end(streamId, "authorizationRevoked");
              return null;
            }
            const frame = {
              lane: "data" as const,
              epoch: this.peer.epoch,
              streamId,
              offsetBytes: offset,
              message: page,
            };
            const n = wireBytes(JSON.stringify(frame), this.peer.port.utf8);
            if (n <= TRANSPORT_LIMITS.maxDataChunkBytes) {
              if (n > capacity) return null;
              finished = true;
              return frame;
            }
            if (!declared) {
              declared = true;
              this.peer.control({
                kind: "transport.content",
                transferId,
                streamId,
                byteLength: data.length,
                encoding: "utf8Json",
              });
              return null;
            }
            return chunk(offset, capacity);
          },
        );
        if (id !== streamId) {
          this.peer.send.end(id, "clientClosed");
          return rejected("invalidState");
        }
        this.histories.set(id, page);
        this.wake();
        return accepted({ kind: "historyReadStarted", streamId });
      }
      case "history.pageSaved": {
        for (const [id, page] of this.histories)
          if (
            page.anchor === req.payload.anchor &&
            page.threadId === req.payload.threadId &&
            req.payload.pageNumber === 0
          ) {
            this.histories.delete(id);
            this.peer.send.finish(id);
            return accepted({ kind: "actionAccepted" });
          }
        return rejected("notFound");
      }
      default:
        return null;
    }
  }
  close() {
    for (const s of this.subs.values()) s.off();
    this.subs.clear();
    this.histories.clear();
  }
}
