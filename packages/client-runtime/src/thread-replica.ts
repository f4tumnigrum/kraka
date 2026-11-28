import * as v from "valibot";
import {
  sameRange,
  type ProjectId,
  type ThreadId,
  FlowPeer,
  matchesAuthorizedConfiguration,
  sendLogicalRequest,
  TRANSPORT_LIMITS,
  CommandReceiptSchema,
  type PrivateSecretRequest,
  keyString,
  type AuthorizationExpectation,
  type ClientAuthentication,
  type CommandReceipt,
  type CommandId,
  type TextReturnResult,
  type ControlMessage,
  type FlowPort,
  type SignedRequest,
  type HistoryPage,
  HistoryPageSchema,
  type ServerHello,
  type SubscriptionPage,
  type TransportFrame,
  type SyncCursor,
  type SubscriptionId,
  ToolActivityDetailFrameSchema,
  TOOL_ACTIVITY_DETAIL_MINOR,
  type ToolActivityDetailFrame,
} from "@kraka/protocol";
import { installEarlierPage } from "./thread-list";
import type { EarlierSettledRequest } from "@kraka/protocol";
import { ThreadInstallation } from "./thread-installation";
import {
  reflectInputReceipt,
  emptyThreadCache,
  installHistoryPage,
  scopeKey,
  type ThreadCache,
  type ThreadCacheStore,
} from "./thread-pass";
import {
  decodeActivityBody,
  type ToolActivityReadOutcome,
  type ToolActivityView,
} from "./tool-activity";

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
type Open = Extract<SignedRequest, { method: "subscription.openThread" }>;
type ActivityOpen = Extract<SignedRequest, { method: "tool.readActivity" }>;
type ActivityReadState = {
  request: ActivityOpen;
  subscriptionId: SubscriptionId;
  onVersion: (view: ToolActivityView) => void;
  onError?: (error: Error) => void;
  frame: ToolActivityDetailFrame | null;
  chain: Promise<void>;
  bound: ReturnType<typeof deferred<boolean>>;
  detached: boolean;
  lastVersion: string | null;
};
type Host = {
  store: ThreadCacheStore;
  read: () => ThreadCache;
  sign: (
    method: SignedRequest["method"],
    payload: unknown,
    commandId?: CommandId,
  ) => SignedRequest | Promise<SignedRequest>;
  id: () => SubscriptionId;
  handshake?: (
    message: Extract<ControlMessage, { kind: "session.authorized" | "session.configuration" }>,
  ) => void;
  opened?: (sub: ThreadInstallation) => void;
  staleBase?: () => void;
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
  private activityReads = new Map<number, ActivityReadState>();
  private parts = new Map<
    number,
    { chunks: Uint8Array[]; length: number; received: number; transferId?: string }
  >();
  private commands = new Map<
    string,
    {
      request: SignedRequest | PrivateSecretRequest;
      done: ReturnType<typeof deferred<CommandReceipt>>;
      reflectInCache: boolean;
    }
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
          this.commands.get(command)?.done.reject(Error("Command receipt interrupted"));
          this.commands.delete(command);
          this.receiptStreams.delete(id);
          this.parts.delete(id);
        }
        this.streams.get(id)?.discarded();
        const viewer = this.activityReads.get(id);
        if (viewer) {
          viewer.onError?.(Error("Activity transfer reset"));
          this.closeActivityLocal(id, viewer);
        }
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
  private request(r: SignedRequest | PrivateSecretRequest, reflectInCache = true) {
    if (this.closed || !this.configured) throw Error("Session unavailable");
    if (this.commands.has(r.commandId)) throw Error("Command already outstanding");
    const done = deferred<CommandReceipt>();
    this.commands.set(r.commandId, { request: r, done, reflectInCache });
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
  private streamTurn = Promise.resolve();
  private orderStream<T>(work: () => Promise<T>) {
    const result = this.streamTurn.then(work);
    this.streamTurn = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  async rpc(method: SignedRequest["method"], payload: unknown, commandId?: CommandId) {
    const send = async () => {
      const signed = await this.sign(method, payload, commandId);
      if (commandId && signed.commandId !== commandId) throw Error("Signed command ID changed");
      return this.request(signed);
    };
    return method.startsWith("todo.") || method === "settings.read" || method === "settings.write"
      ? this.orderStream(send)
      : send();
  }
  async submitInput(
    intent: Pick<
      Extract<SignedRequest, { method: "input.send" }>,
      "method" | "payload" | "commandId"
    >,
    active: () => boolean,
    expire?: (run: () => void) => () => void,
  ) {
    const request = await this.sign(intent.method, intent.payload, intent.commandId);
    if (!active() || request.method !== intent.method || request.commandId !== intent.commandId)
      throw Error("Input scope changed");
    const pending = this.request(request, false);
    const cancel = expire?.(() => {
      const slot = this.commands.get(request.commandId);
      if (slot?.request !== request) return;
      this.commands.delete(request.commandId);
      slot.done.reject(Error("Input receipt timed out"));
    });
    try {
      return { request, receipt: await pending };
    } finally {
      cancel?.();
    }
  }
  async submitQueueEdit(
    intent: Extract<SignedRequest, { method: "input.editQueued" }>["payload"],
    commandId: CommandId,
  ) {
    const request = await this.sign("input.editQueued", intent, commandId);
    if (request.method !== "input.editQueued" || request.commandId !== commandId)
      throw Error("Unexpected edit");
    return { request, receipt: await this.request(request) };
  }
  async submitSecret(sign: () => Promise<PrivateSecretRequest>) {
    if (!this.authorized?.features.includes("privateSecretSubmission"))
      throw Error("Confidential submission unavailable");
    return this.orderStream(async () => {
      const signed = this.signing.then(sign);
      this.signing = signed.then(
        () => {},
        () => {},
      );
      return this.request(await signed);
    });
  }
  private async invalidate(cursor: SyncCursor | null, listShapeChanged = false) {
    if (!cursor) return;
    await this.host.store.transact((old) => {
      const key = scopeKey(cursor),
        current = old.scopes[key]?.cursor;
      if (!current || !sameRange(current, cursor)) return { next: old, result: undefined };
      if (listShapeChanged && cursor.scope.kind === "list") {
        const scopes = { ...old.scopes };
        delete scopes[key];
        return { next: { ...old, scopes }, result: undefined };
      }
      return { next: emptyThreadCache(), result: undefined };
    });
  }
  openList(projectId: ProjectId | null, cached: SyncCursor | null, cold = false, mayReset = true) {
    return this.orderStream(() =>
      this.openScope({ kind: "list", projectId }, cached, cold, mayReset),
    );
  }
  async open(
    threadId: Open["payload"]["threadId"],
    cached: SyncCursor | null,
    cold = false,
    mayReset = true,
  ) {
    return this.orderStream(() =>
      this.openScope({ kind: "thread", threadId }, cached, cold, mayReset),
    );
  }
  private async openScope(
    scope: { kind: "list"; projectId: ProjectId | null } | { kind: "thread"; threadId: ThreadId },
    cached: SyncCursor | null,
    cold = false,
    mayReset = true,
  ) {
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
          (scope.kind === "list" || row.value.threadId === scope.threadId) &&
          row.value.state.kind === "open"
            ? [row.value.id]
            : [],
        )
      : [];
    const streamId = ++this.lastId;
    const membership = after && cache.scopes[scopeKey(after)];
    const req =
      scope.kind === "list"
        ? await this.sign("subscription.openList", {
            projectId: scope.projectId,
            streamId,
            subscriptionId: this.host.id(),
            after,
            windowShapeVersion: 2,
            knownThreads: membership
              ? Object.values(membership.listRows ?? {}).map(({ threadId, version }) => ({
                  threadId,
                  version,
                }))
              : [],
            recheckTodos: [
              ...new Set([
                ...recheckTodos,
                ...(membership
                  ? Object.values(membership.facts ?? {}).flatMap((f) =>
                      [f.root, ...f.descendants].flatMap((s) =>
                        s.requests
                          .filter((r) => r.request.state.kind === "open")
                          .map((r) => r.request.id),
                      ),
                    )
                  : []),
              ]),
            ],
          })
        : await this.sign("subscription.openThread", {
            threadId: scope.threadId,
            streamId,
            subscriptionId: this.host.id(),
            after,
            knownWindow,
            recheckTodos,
          });
    if (req.method !== "subscription.openThread" && req.method !== "subscription.openList")
      throw Error("Unexpected signed intent");
    const sub = new ThreadInstallation(
      req,
      {
        store: this.host.store,
        owner: this.expected.principal.id,
        ack: (a) => {
          void this.rpc(a.method, a.payload)
            .then((receipt) => {
              if (receipt.kind === "accepted" && a.method === "subscription.installed")
                this.host.acknowledged?.(a.payload.cursor);
            })
            .catch(() => this.close());
        },
        ...(this.host.staleBase ? { staleBase: this.host.staleBase } : {}),
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
            if (incompatible)
              await this.invalidate(sub.state.installed ?? cached, reason === "shapeChanged");
            if (mayReset && !this.closed)
              await (
                await this.orderStream(() =>
                  this.openScope(scope, incompatible ? null : cached, true, false),
                )
              ).receipt;
          };
          void restart().catch(() => this.close());
        },
      },
      cached,
    );
    this.streams.set(streamId, sub);
    this.host.opened?.(sub);
    this.peer.receive.open(streamId);
    return { sub, receipt: this.request(req), streamId };
  }
  async earlier(head: SyncCursor, after: EarlierSettledRequest["after"] = null) {
    if (head.scope.kind !== "list" || head.environmentId !== this.hello.identity.id)
      throw Error("Expected authorized list");
    const target =
      head.scope.projectId === null
        ? { kind: "environment", environmentId: head.environmentId }
        : { kind: "project", projectId: head.scope.projectId };
    const receipt = await this.orderStream(() =>
      this.rpc("thread.readEarlierSettled", { target, after }),
    );
    if (receipt.kind !== "accepted" || receipt.result.kind !== "earlierSettled")
      throw Error(receipt.kind === "rejected" ? receipt.failure.kind : "Earlier page unavailable");
    const page = receipt.result.page;
    await installEarlierPage(this.host.store, head, after, page);
    return page;
  }
  async history(
    head: SyncCursor,
    anchor: HistoryPage["anchor"] | null,
    allows: Parameters<typeof installHistoryPage>[2]["allows"],
  ) {
    return this.orderStream(() => this.readHistory(head, anchor, allows));
  }
  private async readHistory(
    head: SyncCursor,
    anchor: HistoryPage["anchor"] | null,
    allows: Parameters<typeof installHistoryPage>[2]["allows"],
  ) {
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
  async readActivity(options: {
    threadId: ActivityOpen["payload"]["threadId"];
    itemId: ActivityOpen["payload"]["itemId"];
    expectedVersion: ActivityOpen["payload"]["expectedVersion"];
    onVersion: (view: ToolActivityView) => void;
    onError?: (error: Error) => void;
  }): Promise<ToolActivityReadOutcome> {
    return this.orderStream(() => this.openActivity(options));
  }
  private async openActivity(
    options: Parameters<ThreadReplica["readActivity"]>[0],
  ): Promise<ToolActivityReadOutcome> {
    if (!this.configured || this.closed) throw Error("Session unavailable");
    if (
      this.expected.protocolVersion.minor < TOOL_ACTIVITY_DETAIL_MINOR ||
      !this.expected.features.includes("timelineItems")
    )
      return { kind: "unsupported" };
    const streamId = ++this.lastId;
    const subscriptionId = this.host.id();
    const request = await this.sign("tool.readActivity", {
      threadId: options.threadId,
      itemId: options.itemId,
      expectedVersion: options.expectedVersion,
      subscriptionId,
      streamId,
    });
    if (request.method !== "tool.readActivity") throw Error("Unexpected signed intent");
    const state: ActivityReadState = {
      request,
      subscriptionId,
      onVersion: options.onVersion,
      ...(options.onError ? { onError: options.onError } : {}),
      frame: null,
      chain: Promise.resolve(),
      bound: deferred<boolean>(),
      detached: false,
      lastVersion: null,
    };
    this.activityReads.set(streamId, state);
    this.peer.receive.open(streamId);
    try {
      const receipt = await this.request(request);
      if (receipt.kind === "rejected") {
        if (receipt.failure.kind === "notFound" || receipt.failure.kind === "missingPermission")
          await this.clearActivity(options.itemId);
        throw Error(`Tool activity read rejected: ${receipt.failure.kind}`);
      }
      if (receipt.kind !== "accepted") throw Error("Unexpected activity receipt");
      if (receipt.result.kind === "activityUnsupported") {
        this.closeActivityLocal(streamId, state);
        return { kind: "unsupported" };
      }
      if (receipt.result.kind === "activityVersionExpired") {
        this.closeActivityLocal(streamId, state);
        return {
          kind: "expired",
          replacement: receipt.result.replacement,
        };
      }
      if (
        receipt.result.kind !== "activityReadStarted" ||
        receipt.result.streamId !== streamId ||
        receipt.result.subscriptionId !== subscriptionId
      )
        throw Error("Mismatched activity stream receipt");
      state.bound.resolve(true);
      return {
        kind: "opened",
        subscriptionId,
        close: () => this.detachActivity(streamId, state),
      };
    } catch (error) {
      this.closeActivityLocal(streamId, state);
      throw error;
    }
  }
  private closeActivityLocal(streamId: number, state: ActivityReadState) {
    state.bound.resolve(false);
    state.detached = true;
    this.activityReads.delete(streamId);
    this.parts.delete(streamId);
    this.peer.receive.cancel(streamId);
  }
  private async detachActivity(streamId: number, state: ActivityReadState) {
    if (state.detached) return;
    state.detached = true;
    try {
      const request = await this.sign("subscription.close", {
        subscriptionId: state.subscriptionId,
      });
      if (request.method === "subscription.close") await this.request(request);
    } finally {
      this.closeActivityLocal(streamId, state);
    }
  }
  private async installActivityBody(
    streamId: number,
    state: ActivityReadState,
    frame: ToolActivityDetailFrame,
    bytes: Uint8Array<ArrayBuffer>,
  ) {
    if (!(await state.bound.promise) || state.detached) return;
    const ref = frame.reference;
    const view = await decodeActivityBody(ref, bytes, this.peer.port.utf8);
    const { item } = view;
    if (state.detached || this.activityReads.get(streamId) !== state) return;
    await this.host.store.transact((old) => {
      if (state.detached) return { next: old, result: undefined };
      const key = JSON.stringify([ref.threadId, ref.itemId]);
      const prior = old.activities?.[key];
      if (prior && BigInt(prior.item.version) > BigInt(item.version))
        return { next: old, result: undefined };
      return {
        next: { ...old, activities: { ...old.activities, [key]: view } },
        result: undefined,
      };
    });
    if (!state.detached) state.onVersion(view);
    if (item.phase === "ended") await this.detachActivity(streamId, state);
  }
  cachedActivity(
    thread: ActivityOpen["payload"]["threadId"],
    item: ActivityOpen["payload"]["itemId"],
  ) {
    const view = this.host.read().activities?.[JSON.stringify([thread, item])];
    return view ? { verified: false as const, view } : null;
  }
  private clearActivity(itemId: string) {
    return this.host.store.transact((old) => ({
      next: {
        ...old,
        activities: Object.fromEntries(
          Object.entries(old.activities ?? {}).filter(([, view]) => view.item.id !== itemId),
        ),
      },
      result: undefined,
    }));
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
      this.host.handshake?.(m);
      return;
    }
    if (
      m.kind === "session.configuration" &&
      this.authorized &&
      matchesAuthorizedConfiguration(this.hello, this.authorized, m, this.expected)
    ) {
      this.configured = true;
      this.host.handshake?.(m);
      this.readySignal.resolve();
      return;
    }
    if (!this.configured) {
      this.close();
      return;
    }
    if (m.kind === "transport.content") {
      const request = this.commands.get(m.transferId)?.request;
      if (
        request &&
        !this.streams.has(m.streamId) &&
        !this.reads.has(m.streamId) &&
        !this.activityReads.has(m.streamId)
      ) {
        if (
          m.streamId !== this.lastId + 1 ||
          m.byteLength < 1 ||
          [...this.parts.values()].reduce((n, p) => n + p.length, m.byteLength) >
            TRANSPORT_LIMITS.maxPendingDataBytes
        )
          throw Error("Invalid command receipt stream");
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
      this.parts.set(m.streamId, {
        length: m.byteLength,
        received: 0,
        chunks: [],
        transferId: m.transferId,
      });
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
      if (
        pending.request.method === "subscription.openThread" ||
        pending.request.method === "subscription.openList"
      )
        this.streams
          .get(pending.request.payload.streamId)
          ?.frame({ epoch: this.peer.epoch, streamId: 0, message: m });
      this.commands.delete(m.commandId);
      if (
        pending.reflectInCache &&
        (pending.request.method === "input.send" || pending.request.method === "thread.start")
      ) {
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
    if (m.kind === "subscription.ended")
      for (const [streamId, state] of this.activityReads)
        if (state.subscriptionId === m.subscriptionId) {
          if (m.reason === "authorizationRevoked")
            void this.clearActivity(state.request.payload.itemId);
          if (m.reason !== "clientClosed")
            state.onError?.(Error(`Activity stream ended: ${m.reason}`));
          this.closeActivityLocal(streamId, state);
        }
  }
  private data(f: Extract<TransportFrame, { lane: "data" }>, size: number) {
    let message: unknown = f.message;
    if ("payload" in f) {
      const t = this.parts.get(f.streamId);
      if (!t) throw Error("Undeclared page");
      if (t.transferId !== f.message.transferId) throw Error("Unexpected content transfer");
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
      const activity = this.activityReads.get(f.streamId);
      if (activity) {
        const frame = activity.frame;
        if (!frame) throw Error("Missing activity detail header");
        activity.frame = null;
        this.peer.control(this.peer.receive.consume(f.streamId, size));
        activity.chain = activity.chain
          .then(() => this.installActivityBody(f.streamId, activity, frame, data))
          .catch((error: unknown) => {
            activity.onError?.(error instanceof Error ? error : Error(String(error)));
            this.closeActivityLocal(f.streamId, activity);
          });
        return;
      }
      message = JSON.parse(this.peer.port.utf8.decode(data));
    }
    this.peer.control(this.peer.receive.consume(f.streamId, size));
    const expected = this.receiptStreams.get(f.streamId);
    if (expected) {
      const r = v.parse(CommandReceiptSchema, message);
      if (String(r.commandId) !== expected) throw Error("Unbound receipt");
      this.receiptStreams.delete(f.streamId);
      this.peer.receive.cancel(f.streamId);
      this.control(r);
      return;
    }
    const activity = this.activityReads.get(f.streamId);
    if (activity) {
      const frame = v.parse(ToolActivityDetailFrameSchema, message);
      if (
        frame.subscriptionId !== activity.subscriptionId ||
        frame.reference.itemId !== activity.request.payload.itemId ||
        activity.frame ||
        (activity.lastVersion !== null &&
          BigInt(frame.reference.version) <= BigInt(activity.lastVersion)) ||
        (activity.lastVersion === null &&
          activity.request.payload.expectedVersion !== null &&
          frame.reference.version !== activity.request.payload.expectedVersion)
      )
        throw Error("Unexpected tool activity detail version");
      this.peer.receive.declare(f.streamId, frame.transferId, frame.reference.byteLength);
      this.parts.set(f.streamId, {
        chunks: [],
        length: frame.reference.byteLength,
        received: 0,
        transferId: frame.transferId,
      });
      activity.frame = frame;
      activity.lastVersion = frame.reference.version;
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
    for (const [streamId, state] of this.activityReads) {
      state.onError?.(error);
      this.closeActivityLocal(streamId, state);
    }
    this.settingListeners.clear();
    this.commands.clear();
    this.streams.clear();
    this.reads.clear();
    this.parts.clear();
    this.receiptStreams.clear();
  }
}
