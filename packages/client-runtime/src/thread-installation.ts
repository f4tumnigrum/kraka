import type { ControlMessage, SignedRequest, SubscriptionPage, SyncCursor } from "@kraka/protocol";
import {
  openThreadFrames,
  stageThreadFrame,
  installThreadPass,
  type ThreadCacheStore,
} from "./thread-pass";

type Open = Parameters<typeof openThreadFrames>[0];
type Acknowledgement = Extract<
  SignedRequest,
  { method: "subscription.pageSaved" | "subscription.installed" | "subscription.gap" }
>;
type Ack = {
  [M in Acknowledgement["method"]]: Pick<
    Extract<Acknowledgement, { method: M }>,
    "method" | "payload"
  >;
}[Acknowledgement["method"]];
export class ThreadInstallation {
  readonly state: ReturnType<typeof openThreadFrames>;
  private work = Promise.resolve();
  private closed = false;
  private saved = new Set<number>();
  private queued = new Set<number>();
  constructor(
    request: Open,
    private host: {
      store: ThreadCacheStore;
      pageStaged?: (page: SubscriptionPage) => Promise<void> | void;
      revoked?: () => void;
      staleBase?: () => void;
      receipt?: () => void;
      installed?: (head: SyncCursor) => void;
      ack: (ack: Ack) => void;
      reset?: (reason: Extract<ControlMessage, { kind: "subscription.reset" }>["reason"]) => void;
    },
    cached: SyncCursor | null = request.payload.after,
  ) {
    this.state = openThreadFrames(request, cached);
  }
  private reportGap() {
    if (this.closed) return;
    this.state.status = "gap";
    this.state.pending = null;
    this.host.ack({
      method: "subscription.gap",
      payload: {
        subscriptionId: this.state.request.payload.subscriptionId,
        after: this.state.installed,
      },
    });
  }
  discarded() {
    if (this.state.status !== "gap") this.reportGap();
  }
  close() {
    this.closed = true;
    this.state.pending = null;
    this.state.bound = false;
    this.state.status = this.state.installed ? "cached" : "empty";
  }
  get settled() {
    return this.work;
  }
  frame(frame: Parameters<typeof stageThreadFrame>[1]) {
    if (this.closed) return;
    const state = this.state,
      wasBound = state.bound,
      oldPass = state.pending;
    const event = stageThreadFrame(state, frame);
    if (event.kind === "gap") {
      this.reportGap();
      return;
    }
    if (event.kind === "reset") {
      this.close();
      this.host.reset?.(event.reason);
      return;
    }
    if (event.kind === "ended") {
      if (event.revoked) {
        this.close();
        this.host.revoked?.();
      } else this.close();
      return;
    }
    if (!wasBound && state.bound) this.host.receipt?.();
    const subscriptionId = state.request.payload.subscriptionId;
    if (event.kind === "repeatInstalled") {
      this.host.ack({
        method: "subscription.installed",
        payload: { subscriptionId, passId: event.seal.passId, cursor: event.seal.cursor },
      });
      return;
    }
    const current = state.pending;
    if (!current || !state.bound) return;
    if (oldPass !== current) {
      this.saved = new Set();
      this.queued = new Set();
    }
    for (const [n, page] of current.pages) {
      if (this.queued.has(n)) continue;
      this.queued.add(n);
      this.work = this.work
        .then(async () => {
          if (this.closed || state.pending !== current) return;
          await this.host.pageStaged?.(page);
          if (this.closed || state.pending !== current) return;
          this.saved.add(n);
          this.host.ack({
            method: "subscription.pageSaved",
            payload: { subscriptionId, passId: page.passId, pageNumber: n },
          });
        })
        .catch(() => this.reportGap());
    }
    if (event.kind !== "sealed") return;
    const expected = state.installed;
    this.work = this.work
      .then(async () => {
        if (this.closed || state.pending !== current || !current.seal) return;
        if (this.saved.size !== current.seal.pages) throw Error("Page staging incomplete");
        const store: ThreadCacheStore = {
          transact: (edit) =>
            this.host.store.transact((old) => {
              if (this.closed || state.pending !== current) throw Error("Abandoned installation");
              return edit(old);
            }),
        };
        if ((await installThreadPass(store, expected, event.pass)) !== "installed") {
          this.reportGap();
          this.host.staleBase?.();
          return;
        }
        if (this.closed || state.pending !== current) return;
        const cursor = current.begin.through;
        state.installed = cursor;
        state.lastSeal = current.seal;
        state.pending = null;
        state.status = "current";
        this.saved.clear();
        this.queued.clear();
        this.host.installed?.(cursor);
        this.host.ack({
          method: "subscription.installed",
          payload: { subscriptionId, passId: current.begin.passId, cursor },
        });
      })
      .catch(() => this.reportGap());
  }
}
