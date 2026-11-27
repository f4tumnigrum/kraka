import { GitObservations, type GitStatusUpdate } from "./git-observations";
export type { GitStatusUpdate } from "./git-observations";
import {
  FlowPeer,
  sendLogicalRequest,
  type GitStatus,
  sameRange,
  sameHead,
  matchesAuthorizedConfiguration,
  readSubscriptionPage,
  TRANSPORT_LIMITS,
  type AuthorizationExpectation,
  type CommandReceipt,
  type ControlMessage,
  type FlowPort,
  type ServerHello,
  type SessionAuthorized,
  type SignedRequest,
  type SubscriptionPage,
  type SyncCursor,
  type SyncPassId,
  type SubscriptionId,
  type TransportFrame,
  type ContentTransferId,
} from "@kraka/protocol";

type Open = Extract<SignedRequest, { method: "subscription.openThread" | "subscription.openList" }>;
type Pass = {
  id: SyncPassId;
  head: SyncCursor;
  pages: SubscriptionPage[];
  size: number;
  count: number | null;
  sealed: boolean;
};
type Sub = {
  request: Open;
  bound: boolean;
  installed: SyncCursor | null;
  live: boolean;
  pass: Pass | null;
  content: { id: ContentTransferId; parts: Uint8Array[]; length: number; received: number } | null;
};
export class EnvironmentRpcUnavailableError extends Error {
  constructor() {
    super("Environment session unavailable");
    this.name = "EnvironmentRpcUnavailableError";
  }
}

export class SubscriptionSession {
  readonly peer: FlowPeer;
  private readonly git: GitObservations;
  private authorization: SessionAuthorized | null = null;
  private ready = false;
  private closed = false;
  failure: Extract<ControlMessage, { kind: "session.rejected" }>["reason"] | null = null;
  private readonly subs = new Map<number, Sub>();
  private readonly requests = new Map<
    SignedRequest["commandId"],
    { request: SignedRequest; resolve: (r: CommandReceipt) => void; reject: (e: Error) => void }
  >();
  private stagedBytes = 0;
  constructor(
    private readonly verifiedHello: ServerHello,
    private readonly expected: AuthorizationExpectation,
    port: FlowPort,
    private readonly install: (pages: readonly SubscriptionPage[], head: SyncCursor) => void,
    private readonly consumed: (id: number, size: number) => number = (_, size) => size,
    onGitStatus: (update: GitStatusUpdate) => void = () => {},
    refreshGit: (
      open: Extract<SignedRequest, { method: "git.subscribeStatus" }>["payload"],
    ) => Promise<GitStatus> = async () => {
      throw Error("Git status refresh unavailable");
    },
  ) {
    this.peer = new FlowPeer(verifiedHello.connectionId, port, {
      control: (m) => this.control(m),
      data: (f, n) => this.data(f, n),
      discarded: (id) => this.drop(id),
    });
    this.git = new GitObservations(this.peer, onGitStatus, refreshGit);
  }
  snapshot(id: number) {
    const sub = this.subs.get(id);
    return {
      environment: this.ready ? "ready" : "unavailable",
      thread: sub ? (sub.live ? "live" : "synchronizing") : "unsubscribed",
      installed: sub?.installed ?? null,
      pages: sub?.bound ? (sub.pass?.pages ?? []) : [],
    };
  }
  async rpc(request: SignedRequest): Promise<CommandReceipt> {
    if (
      !this.ready ||
      request.connectionId !== this.peer.epoch ||
      request.environmentId !== this.verifiedHello.identity.id
    )
      throw new EnvironmentRpcUnavailableError();
    if (this.requests.has(request.commandId)) throw new Error("Duplicate outstanding command");
    if (
      request.method === "subscription.openList" ||
      request.method === "subscription.openThread"
    ) {
      const { streamId, after } = request.payload;
      if (this.bySubscription(request.payload.subscriptionId))
        throw new Error("Duplicate subscription");
      this.peer.receive.open(streamId);
      this.subs.set(streamId, {
        request,
        installed: after,
        bound: false,
        pass: null,
        live: false,
        content: null,
      });
    }
    if (request.method === "git.subscribeStatus") this.git.open(request.payload);
    if (
      request.method === "checkpoint.diff" &&
      "directoryId" in request.payload.query &&
      !this.authorization?.features.includes("directoryDiff")
    )
      return { kind: "rejected", commandId: request.commandId, failure: { kind: "unsupported" } };
    return new Promise((resolve, reject) => {
      this.requests.set(request.commandId, { request, resolve, reject });
      try {
        sendLogicalRequest(this.peer, request);
        this.peer.pump();
      } catch (error) {
        if (request.method === "git.subscribeStatus") this.git.drop(request.payload.streamId);
        this.requests.delete(request.commandId);
        if (
          request.method === "subscription.openList" ||
          request.method === "subscription.openThread"
        )
          this.drop(request.payload.streamId);
        reject(error);
      }
    });
  }
  private bySubscription(id: SubscriptionId) {
    for (const sub of this.subs.values()) if (sub.request.payload.subscriptionId === id) return sub;
  }
  private control(m: ControlMessage) {
    if (
      m.kind === "server.hello" &&
      !this.authorization &&
      m.identityProof === this.verifiedHello.identityProof
    )
      return;
    if (m.kind === "session.rejected") {
      this.failure = m.reason;
      this.close();
      return;
    }
    if (m.kind === "session.authorized" && !this.authorization && !this.closed) {
      if (m.connectionId !== this.peer.epoch) throw new Error("Wrong authorization epoch");
      this.authorization = m;
      return;
    }
    if (
      m.kind === "session.configuration" &&
      this.authorization &&
      !this.ready &&
      matchesAuthorizedConfiguration(this.verifiedHello, this.authorization, m, this.expected)
    ) {
      this.ready = true;
      return;
    }
    if (!this.ready || m.kind === "session.configuration" || m.kind === "session.authorized") {
      this.close();
      throw new EnvironmentRpcUnavailableError();
    }
    if (m.kind === "transport.probe") {
      this.peer.control({ kind: "transport.echo", serial: m.serial });
      return;
    }
    if (m.kind === "accepted" || m.kind === "rejected" || m.kind === "programError") {
      const entry = this.requests.get(m.commandId);
      if (!entry) return;
      this.requests.delete(m.commandId);
      const r = entry.request;
      if (r.method === "subscription.openThread" || r.method === "subscription.openList") {
        const { streamId, subscriptionId } = r.payload;
        const sub = this.subs.get(streamId);
        if (
          !sub ||
          m.kind !== "accepted" ||
          m.result.kind !== "subscriptionOpened" ||
          m.result.streamId !== streamId ||
          m.result.subscriptionId !== subscriptionId
        ) {
          this.drop(streamId);
          if (m.kind === "accepted") {
            entry.reject(new Error("Mismatched subscription receipt"));
            return;
          }
        } else {
          sub.bound = true;
          this.installSealed(sub);
        }
      }
      if (r.method === "git.subscribeStatus") {
        try {
          this.git.bind(r.payload, m);
        } catch (error) {
          entry.reject(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      }
      entry.resolve(m);
      return;
    }
    if (m.kind === "transport.content") {
      const receipt = [...this.requests.values()].some(
        (e) =>
          String(e.request.commandId) === String(m.transferId) &&
          (e.request.method === "checkpoint.diff" || e.request.method === "git.readStatus"),
      );
      if (this.git.declare(m, receipt)) return;
      const sub = this.subs.get(m.streamId);
      if (
        !sub?.pass ||
        sub.content ||
        m.byteLength < 1 ||
        m.byteLength > TRANSPORT_LIMITS.maxPendingDataBytes
      ) {
        this.cancel(m.streamId);
        return;
      }
      this.peer.receive.declare(m.streamId, m.transferId, m.byteLength);
      sub.content = { id: m.transferId, parts: [], length: m.byteLength, received: 0 };
      return;
    }
    if (!("subscriptionId" in m)) return;
    if (m.kind === "subscription.ended" || m.kind === "subscription.reset")
      this.git.ended(m.subscriptionId);
    const sub = this.bySubscription(m.subscriptionId);
    if (!sub) return;
    const id = sub.request.payload.streamId;
    if (m.kind === "subscription.ended" || m.kind === "subscription.reset") {
      this.drop(id);
      return;
    }
    if (m.kind === "subscription.begin") {
      const scope = m.through.scope,
        r = sub.request;
      const scopeMatches =
        r.method === "subscription.openThread"
          ? scope.kind === "thread" && scope.threadId === r.payload.threadId
          : scope.kind === "list" && scope.projectId === r.payload.projectId;
      if (
        sub.pass ||
        !scopeMatches ||
        m.through.environmentId !== r.environmentId ||
        (m.mode === "merge" &&
          (!sub.installed ||
            !m.base ||
            !sameHead(m.base, sub.installed) ||
            !sameRange(m.base, m.through) ||
            BigInt(m.through.through) < BigInt(m.base.through)))
      ) {
        this.cancel(id);
        return;
      }
      sub.live = false;
      sub.pass = { id: m.passId, head: m.through, pages: [], count: null, size: 0, sealed: false };
    } else if (m.kind === "subscription.seal") {
      const p = sub.pass;
      if (
        !p ||
        p.id !== m.passId ||
        !sameHead(p.head, m.cursor) ||
        p.pages.length !== m.pages ||
        (p.count !== null && p.count !== m.pages) ||
        sub.content
      ) {
        this.cancel(id);
        return;
      }
      p.sealed = true;
      this.installSealed(sub);
    }
  }
  private installSealed(sub: Sub) {
    const p = sub.pass;
    if (!sub.bound || !p?.sealed) return;
    this.install(p.pages, p.head);
    sub.installed = p.head;
    sub.live = true;
    this.stagedBytes -= p.size;
    sub.pass = null;
  }
  private data(frame: Extract<TransportFrame, { lane: "data" }>, size: number) {
    if (this.ready && this.git.data(frame, size, (receipt) => this.control(receipt))) return;
    const sub = this.subs.get(frame.streamId);
    if (!sub || !this.ready) throw new Error("Data on unavailable subscription");
    let page: SubscriptionPage | null = null;
    let retained = size;
    if ("payload" in frame) {
      const t = sub.content;
      if (!t || t.id !== frame.message.transferId) throw new Error("Undeclared content");
      if (this.stagedBytes + frame.payload.length > TRANSPORT_LIMITS.maxPendingDataBytes)
        throw new Error("Receive budget exhausted");
      t.parts.push(frame.payload.slice());
      t.received += frame.payload.length;
      this.stagedBytes += frame.payload.length;
      if (t.received === t.length) {
        const bytes = new Uint8Array(t.length);
        let offset = 0;
        for (const part of t.parts) {
          bytes.set(part, offset);
          offset += part.length;
        }
        const result = readSubscriptionPage(
          JSON.parse(this.peer.port.utf8.decode(bytes)),
          sub.installed,
        );
        if (result.kind !== "page") throw new Error("Invalid subscription page");
        page = result.page;
        retained = t.length;
        this.stagedBytes -= retained;
        sub.content = null;
      }
    } else if (frame.message.kind === "subscription.page") page = frame.message;
    else throw new Error("Unexpected subscription data");
    if (page) {
      const p = sub.pass;
      if (
        !p ||
        p.sealed ||
        page.subscriptionId !== sub.request.payload.subscriptionId ||
        page.passId !== p.id ||
        !sameHead(p.head, page.through) ||
        page.pageNumber !== p.pages.length ||
        page.pageNumber >= page.pageCount ||
        (p.count !== null && p.count !== page.pageCount) ||
        this.stagedBytes + retained > TRANSPORT_LIMITS.maxPendingDataBytes
      )
        throw new Error("Invalid subscription page sequence");
      p.pages.push(page);
      p.count = page.pageCount;
      p.size += retained;
      this.stagedBytes += retained;
    }
    const bytes = this.consumed(frame.streamId, size);
    if (bytes) this.acknowledge(frame.streamId, bytes);
  }
  acknowledge(id: number, bytes: number) {
    this.peer.control(this.peer.receive.consume(id, bytes));
  }
  cancel(id: number) {
    this.drop(id);
    this.peer.control({ kind: "stream.reset", streamId: id, reason: "cancelled" });
  }
  private drop(id: number) {
    this.git.drop(id);
    const sub = this.subs.get(id);
    if (sub) {
      this.stagedBytes -= (sub.content?.received ?? 0) + (sub.pass?.size ?? 0);
      const pending = this.requests.get(sub.request.commandId);
      this.requests.delete(sub.request.commandId);
      pending?.reject(new Error("Subscription closed before its receipt"));
    }
    this.subs.delete(id);
    this.peer.receive.cancel(id);
  }
  close() {
    this.closed = true;
    this.ready = false;
    this.git.close();
    this.peer.close();
    this.subs.clear();
    this.stagedBytes = 0;
    for (const entry of this.requests.values()) entry.reject(new EnvironmentRpcUnavailableError());
    this.requests.clear();
  }
}
