import {
  sameRange,
  FlowPeer,
  matchesAuthorizedConfiguration,
  sendLogicalRequest,
  TRANSPORT_LIMITS,
  keyString,
  type AuthorizationExpectation,
  type ClientAuthentication,
  type CommandReceipt,
  type CommandId,
  type TextReturnResult,
  CommandReceiptSchema,
  type ControlMessage,
  type FlowPort,
  type SignedRequest,
  type HistoryPage,
  type ServerHello,
  type SubscriptionPage,
  type TransportFrame,
  type SyncCursor,
  type SubscriptionId,
} from "@kraka/protocol";
import { ThreadInstallation } from "./thread-installation";
import {
  reflectInputReceipt,
  emptyThreadCache,
  installHistoryPage,
  scopeKey,
  type ThreadCache,
  type ThreadCacheStore,
} from "./thread-pass";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Open = Extract<SignedRequest, { method: "subscription.openThread" }>;
type Host = {
  store: ThreadCacheStore;
  read: () => ThreadCache;
  sign: (
    method: SignedRequest["method"],
    payload: unknown,
    commandId?: CommandId,
  ) => SignedRequest | Promise<SignedRequest>;
  id: () => SubscriptionId;
  receipt?: () => void;
  textReturned?: (commandId: CommandId, result: TextReturnResult) => void;
  pageStaged?: (page: SubscriptionPage) => void | Promise<void>;
  acknowledged?: (head: SyncCursor) => void;
  installed?: (head: SyncCursor) => void;
  received?: (kind: string, message: unknown) => void;
};
export class ThreadReplica {
  readonly peer: FlowPeer;
  readonly ready: Promise<void>;
  private readySignal = deferred<void>();
  private authorized: Extract<ControlMessage, { kind: "session.authorized" }> | null = null;
  private configured = false;
  private streams = new Map<number, ThreadInstallation>();
  private reads = new Map<
    number,
    {
      request: Extract<SignedRequest, { method: "thread.readHistory" }>;
      head: SyncCursor;
      bound: boolean;
      page: HistoryPage | null;
      allows: Parameters<typeof installHistoryPage>[2]["allows"];
      result: ReturnType<typeof deferred<HistoryPage>>;
    }
  >();
  private parts = new Map<number, { chunks: Uint8Array[]; length: number; received: number }>();
  private commands = new Map<
    string,
    { request: SignedRequest; done: ReturnType<typeof deferred<CommandReceipt>> }
  >();
  private lastId = 0;
  private closed = false;
  constructor(
    readonly hello: ServerHello,
    private expected: AuthorizationExpectation,
    port: FlowPort,
    private host: Host,
  ) {
    this.ready = this.readySignal.promise;
    this.peer = new FlowPeer(hello.connectionId, port, {
      control: (m) => this.control(m),
      data: (f, n) => this.data(f, n),
      discarded: (id) => {
        const command = this.receiptStreams.get(id);
        if (command) {
          this.commands.get(command)?.done.reject(Error("Setting receipt interrupted"));
          this.commands.delete(command);
          this.receiptStreams.delete(id);
          this.parts.delete(id);
        }
        this.streams.get(id)?.discarded();
      },
    });
  }
  authenticate(
    first: Extract<TransportFrame, { lane: "control" }>,
    size: number,
    auth: ClientAuthentication,
  ) {
    this.peer.receive.receive(first, size);
    this.peer.control(auth);
    this.peer.pump();
  }
  private request(r: SignedRequest) {
    if (this.closed || !this.configured) throw Error("Session unavailable");
    if (this.commands.has(r.commandId)) throw Error("Command already outstanding");
    const done = deferred<CommandReceipt>();
    this.commands.set(r.commandId, { request: r, done });
    try {
      sendLogicalRequest(this.peer, r);
      this.peer.pump();
    } catch (e) {
      this.commands.delete(r.commandId);
      throw e;
    }
    return done.promise;
  }
  private settingListeners = new Set<(r: CommandReceipt) => Promise<void>>();
  onSettingReceipt(receive: (r: CommandReceipt) => Promise<void>) {
    this.settingListeners.add(receive);
    return () => {
      this.settingListeners.delete(receive);
    };
  }
  private settingReplies = new Set<Promise<CommandReceipt>>();
  private receiptStreams = new Map<number, CommandId>();
  private signing = Promise.resolve();
  private sign(method: SignedRequest["method"], payload: unknown, commandId?: CommandId) {
    const signed = this.signing.then(() => this.host.sign(method, payload, commandId));
    this.signing = signed.then(
      () => {},
      () => {},
    );
    return signed;
  }
  async rpc(method: SignedRequest["method"], payload: unknown, commandId?: CommandId) {
    const reply = this.sign(method, payload, commandId).then((signed) => {
      if (commandId && signed.commandId !== commandId) throw Error("Signed command ID changed");
      return this.request(signed);
    });
    if (method !== "settings.read" && method !== "settings.write") return reply;
    this.settingReplies.add(reply);
    try {
      return await reply;
    } finally {
      this.settingReplies.delete(reply);
    }
  }
  private async invalidate(cursor: SyncCursor | null) {
    if (!cursor) return;
    await this.host.store.transact((old) => {
      const current = old.scopes[scopeKey(cursor)]?.cursor;
      return {
        next: current && sameRange(current, cursor) ? emptyThreadCache() : old,
        result: undefined,
      };
    });
  }
  async open(
    threadId: Open["payload"]["threadId"],
    cached: SyncCursor | null,
    cold = false,
    mayReset = true,
  ) {
    while (this.settingReplies.size) await Promise.allSettled(this.settingReplies);
    const cache = this.host.read(),
      after = cold ? null : cached;
    const members = after ? Object.values(cache.scopes[scopeKey(after)]?.members ?? {}) : [];
    const knownWindow = members.flatMap((key) => {
      const row = cache.rows[keyString(key)];
      return row?.row ? [{ key, version: row.version }] : [];
    });
    const recheckTodos = after
      ? Object.values(cache.rows).flatMap(({ row }) =>
          row?.objectType === "todoRequest" &&
          row.value.threadId === threadId &&
          row.value.state.kind === "open"
            ? [row.value.id]
            : [],
        )
      : [];
    const streamId = ++this.lastId;
    const req = await this.sign("subscription.openThread", {
      threadId,
      streamId,
      subscriptionId: this.host.id(),
      after,
      knownWindow,
      recheckTodos,
    });
    if (req.method !== "subscription.openThread") throw Error("Unexpected signed intent");
    const sub = new ThreadInstallation(
      req,
      {
        store: this.host.store,
        ack: (a) => {
          void this.rpc(a.method, a.payload)
            .then((receipt) => {
              if (receipt.kind === "accepted" && a.method === "subscription.installed")
                this.host.acknowledged?.(a.payload.cursor);
            })
            .catch(() => this.close());
        },
        ...(this.host.receipt ? { receipt: this.host.receipt } : {}),
        ...(this.host.pageStaged ? { pageStaged: this.host.pageStaged } : {}),
        ...(this.host.installed ? { installed: this.host.installed } : {}),
        revoked: () => {
          void this.invalidate(cached ?? sub.state.installed);
        },
        reset: (reason) => {
          this.peer.receive.cancel(streamId);
          this.streams.delete(streamId);
          const incompatible =
            reason === "authorizationChanged" ||
            reason === "databaseGenerationChanged" ||
            reason === "shapeChanged";
          const restart = async () => {
            if (incompatible) await this.invalidate(cached);
            if (mayReset && !this.closed)
              await (await this.open(threadId, incompatible ? null : cached, true, false)).receipt;
          };
          void restart().catch(() => this.close());
        },
      },
      cached,
    );
    this.streams.set(streamId, sub);
    this.peer.receive.open(streamId);
    return { sub, receipt: this.request(req), streamId };
  }
  async history(
    head: SyncCursor,
    anchor: HistoryPage["anchor"] | null,
    allows: Parameters<typeof installHistoryPage>[2]["allows"],
  ) {
    while (this.settingReplies.size) await Promise.allSettled(this.settingReplies);
    if (head.scope.kind !== "thread") throw Error("Expected thread history");
    const streamId = ++this.lastId,
      request = await this.sign("thread.readHistory", {
        threadId: head.scope.threadId,
        streamId,
        anchor,
      });
    if (request.method !== "thread.readHistory") throw Error("Unexpected signed intent");
    this.peer.receive.open(streamId);
    const result = deferred<HistoryPage>();
    this.reads.set(streamId, { request, head, bound: false, page: null, allows, result });
    try {
      const receipt = await this.request(request);
      if (
        receipt.kind !== "accepted" ||
        receipt.result.kind !== "historyReadStarted" ||
        receipt.result.streamId !== streamId
      )
        throw Error("History not authorized");
      const r = this.reads.get(streamId);
      if (!r) throw Error("History abandoned");
      r.bound = true;
      this.saveHistory(streamId);
      return await result.promise;
    } finally {
      this.reads.delete(streamId);
      this.peer.receive.cancel(streamId);
    }
  }
  private saveHistory(id: number) {
    const r = this.reads.get(id);
    if (!r?.bound || !r.page) return;
    const page = r.page;
    r.page = null;
    void installHistoryPage(this.host.store, page, {
      head: r.head,
      threadId: r.request.payload.threadId,
      anchor: r.request.payload.anchor,
      timelineItems: this.expected.features.includes("timelineItems"),
      allows: r.allows,
    })
      .then(async () => {
        await this.rpc("history.pageSaved", {
          threadId: page.threadId,
          anchor: page.anchor,
          pageNumber: page.pageNumber,
        });
        r.result.resolve(page);
      })
      .catch(r.result.reject);
  }
  private control(m: ControlMessage) {
    if (m.kind === "session.authorized") {
      this.authorized = m;
      return;
    }
    if (
      m.kind === "session.configuration" &&
      this.authorized &&
      matchesAuthorizedConfiguration(this.hello, this.authorized, m, this.expected)
    ) {
      this.configured = true;
      this.readySignal.resolve();
      return;
    }
    if (!this.configured) {
      this.close();
      return;
    }
    if (m.kind === "transport.content") {
      const request = this.commands.get(m.transferId)?.request;
      if (request && (request.method === "settings.read" || request.method === "settings.write")) {
        if (
          m.streamId !== this.lastId + 1 ||
          m.byteLength < 1 ||
          [...this.parts.values()].reduce((n, p) => n + p.length, m.byteLength) >
            TRANSPORT_LIMITS.maxPendingDataBytes
        )
          throw Error("Invalid setting receipt stream");
        this.peer.receive.open(m.streamId);
        this.lastId = m.streamId;
        this.receiptStreams.set(m.streamId, request.commandId);
      }
      if (
        (!this.streams.has(m.streamId) &&
          !this.reads.has(m.streamId) &&
          !this.receiptStreams.has(m.streamId)) ||
        m.byteLength > TRANSPORT_LIMITS.maxPendingDataBytes
      )
        throw Error("Unexpected logical page");
      this.peer.receive.declare(m.streamId, m.transferId, m.byteLength);
      this.parts.set(m.streamId, { length: m.byteLength, received: 0, chunks: [] });
      return;
    }
    this.host.received?.(m.kind, m);
    if (m.kind === "accepted" || m.kind === "programError" || m.kind === "rejected") {
      if (m.kind === "accepted" && m.result.kind === "textReturned") {
        if (m.result.target.environmentId === this.hello.identity.id)
          this.host.textReturned?.(m.commandId, m.result);
        return;
      }
      const pending = this.commands.get(m.commandId);
      if (!pending) {
        for (const listener of this.settingListeners) void listener(m).catch(() => this.close());
        return;
      }
      if (pending.request.method === "subscription.openThread")
        this.streams
          .get(pending.request.payload.streamId)
          ?.frame({ epoch: this.peer.epoch, streamId: 0, message: m });
      this.commands.delete(m.commandId);
      if (pending.request.method === "input.send") {
        void Promise.resolve(reflectInputReceipt(this.host.store, pending.request, m)).then(
          () => pending.done.resolve(m),
          pending.done.reject,
        );
      } else pending.done.resolve(m);
      return;
    }
    if ("subscriptionId" in m)
      for (const s of this.streams.values())
        if (s.state.request.payload.subscriptionId === m.subscriptionId)
          s.frame({ epoch: this.peer.epoch, streamId: 0, message: m });
  }
  private data(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
    let message: unknown = f.message;
    if ("payload" in f) {
      const t = this.parts.get(f.streamId);
      if (!t) throw Error("Undeclared page");
      t.chunks.push(f.payload.slice());
      t.received += f.payload.length;
      if (t.received !== t.length) {
        this.peer.control(this.peer.receive.consume(f.streamId, size));
        return;
      }
      const data = new Uint8Array(t.length);
      let pos = 0;
      for (const c of t.chunks) {
        data.set(c, pos);
        pos += c.length;
      }
      this.parts.delete(f.streamId);
      message = JSON.parse(this.peer.port.utf8.decode(data));
    }
    this.peer.control(this.peer.receive.consume(f.streamId, size));
    const expected = this.receiptStreams.get(f.streamId);
    if (expected) {
      this.receiptStreams.delete(f.streamId);
      this.peer.receive.cancel(f.streamId);
      const receipt = v.parse(CommandReceiptSchema, message);
      if (receipt.commandId !== expected) throw Error("Wrong receipt transfer");
      this.control(receipt);
      return;
    }
    const s = this.streams.get(f.streamId);
    if (s) {
      this.host.received?.("subscription.page", message);
      s.frame({ epoch: f.epoch, streamId: f.streamId, message });
      return;
    }
    const r = this.reads.get(f.streamId);
    if (!r) throw Error("Unbound read stream");
    r.page = v.parse(HistoryPageSchema, message);
    this.saveHistory(f.streamId);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.configured = false;
    this.peer.close();
    const error = Error("Thread connection closed");
    this.readySignal.reject(error);
    for (const sub of this.streams.values()) sub.close();
    for (const { done } of this.commands.values()) done.reject(error);
    for (const { result } of this.reads.values()) result.reject(error);
    this.settingListeners.clear();
    this.receiptStreams.clear();
    this.commands.clear();
    this.streams.clear();
    this.reads.clear();
    this.parts.clear();
  }
}
import * as v from "valibot";
import { HistoryPageSchema } from "@kraka/protocol";
