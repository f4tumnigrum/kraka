import { canonicalJson, type AccountQuotaSnapshot, type QuotaWindow } from "@kraka/protocol";
import type { AccountBinding, AccountUsageStore } from "./account-usage";

export type QuotaClock = {
  now(): number;
  schedule(at: number, callback: () => Promise<void>): () => void;
};
const realClock: QuotaClock = {
  now: Date.now,
  schedule(at, callback) {
    const timer = setTimeout(
      () => void callback().catch((error) => console.error(error)),
      Math.max(0, at - Date.now()),
    );
    timer.unref();
    return () => clearTimeout(timer);
  },
};
export type QuotaReply =
  | { outcome: "success"; account: string; mode: "full" | "partial"; windows: QuotaWindow[] }
  | { outcome: "unsupported" | "probeFailed" | "discarded" };
export type QuotaTarget = {
  binding: AccountBinding;
  query(signal: AbortSignal): Promise<QuotaReply>;
};
export type QuotaCounts = { subscriptions: number; queries: number; scheduledChecks: number };
export type QuotaSignal =
  | { kind: "refreshJoined"; account: string | null; refresh: number }
  | {
      kind: "refreshFinished";
      account: string | null;
      refresh: number;
      outcome: "success" | "unsupported" | "probeFailed" | "discarded";
    }
  | { kind: "detached"; counts: QuotaCounts };
type Resolve = () => QuotaTarget | null;
type View = { resolve: Resolve; publish: (s: AccountQuotaSnapshot) => void };
type Flight = {
  id: number;
  done: Promise<AccountQuotaSnapshot | null>;
  abort: AbortController;
  readers: Set<symbol>;
};
export class QuotaRefresh {
  private readonly views = new Set<View>();
  private readonly active = new Map<string, Flight>();
  private cancelAutomatic: (() => void) | null = null;
  private closed = false;
  constructor(
    private store: AccountUsageStore,
    private clock: QuotaClock = realClock,
    private signal: (event: QuotaSignal) => void = () => {},
  ) {}
  counts(): QuotaCounts {
    return {
      subscriptions: this.views.size,
      queries: this.active.size,
      scheduledChecks: Number(this.cancelAutomatic !== null),
    };
  }
  read(resolve: Resolve) {
    const target = resolve();
    if (!target) return null;
    this.store.bind(target.binding);
    return this.store.read(target.binding, this.clock.now());
  }
  subscribe(resolve: Resolve, publish: View["publish"]) {
    const view = { resolve, publish };
    this.views.add(view);
    const first = this.read(resolve);
    if (first) publish(first);
    this.schedule();
    return () => {
      if (!this.views.delete(view)) return;
      if (!this.views.size) {
        this.cancelAutomatic?.();
        this.cancelAutomatic = null;
        const automatic = [...this.active.values()].filter((query) => !query.readers.size);
        for (const query of automatic) query.abort.abort();
        const detached = () => {
          if (!this.views.size) this.signal({ kind: "detached", counts: this.counts() });
        };
        if (automatic.length)
          void Promise.allSettled(automatic.map((query) => query.done)).then(detached);
        else detached();
      }
    };
  }
  private schedule() {
    if (this.cancelAutomatic || !this.views.size || this.closed) return;
    const last = this.store.lastAutomaticAttempt();
    this.cancelAutomatic = this.clock.schedule(
      last === null ? this.clock.now() : last + 300000,
      async () => {
        this.cancelAutomatic = null;
        if (!this.views.size || this.closed) return;
        this.store.attemptedAutomatically(this.clock.now());
        try {
          await Promise.all(Array.from(this.views, (view) => this.refresh(view.resolve, false)));
        } finally {
          this.schedule();
        }
      },
    );
  }
  private publish(key: string, snapshot: AccountQuotaSnapshot) {
    for (const view of this.views) {
      const target = view.resolve();
      if (target && canonicalJson(target.binding) === key) view.publish(snapshot);
    }
  }
  observe(target: QuotaTarget, account: string, windows: QuotaWindow[]) {
    if (this.closed || target.binding.source.account !== account) return;
    const now = this.clock.now(),
      binding = target.binding;
    this.store.bind(binding);
    const ticket = this.store.begin(binding, now);
    if (
      this.store.applyQuotaObservation({
        ...ticket,
        observedAt: now,
        attemptedAt: now,
        mode: "partial",
        outcome: "success",
        windows,
      })
    )
      this.publish(canonicalJson(binding), this.store.read(binding, now));
  }
  refresh(
    resolve: Resolve,
    manual = true,
    signal?: AbortSignal,
  ): Promise<AccountQuotaSnapshot | null> {
    const target = resolve();
    if (!target || this.closed || signal?.aborted) return Promise.resolve(null);
    const binding = target.binding,
      key = canonicalJson(binding),
      account = binding.source.account;
    const flight = this.active.get(key);
    if (flight && !flight.abort.signal.aborted) {
      this.signal({ kind: "refreshJoined", account, refresh: flight.id });
      return this.wait(flight, key, manual, signal);
    }
    this.store.bind(binding);
    const attemptedAt = this.clock.now(),
      ticket = this.store.begin(binding, attemptedAt);
    const abort = new AbortController(),
      timeout = Promise.withResolvers<QuotaReply>();
    const onAbort = () =>
      timeout.resolve({
        outcome: abort.signal.reason === "deadline" ? "probeFailed" : "discarded",
      });
    abort.signal.addEventListener("abort", onAbort, { once: true });
    const cancel = this.clock.schedule(attemptedAt + 10000, async () => {
      abort.abort("deadline");
      await done;
    });
    const done = Promise.resolve()
      .then(async () => {
        const reply = await Promise.race([
          target.query(abort.signal).catch((): QuotaReply => ({ outcome: "probeFailed" })),
          timeout.promise,
        ]);
        const current = resolve(),
          same = current && canonicalJson(current.binding) === key;
        const outcome =
          reply.outcome === "success" && reply.account !== account ? "discarded" : reply.outcome;
        const committed =
          !!same &&
          outcome !== "discarded" &&
          this.store.applyQuotaObservation({
            ...ticket,
            attemptedAt,
            observedAt: this.clock.now(),
            outcome,
            mode: reply.outcome === "success" ? reply.mode : "full",
            windows: reply.outcome === "success" ? reply.windows : [],
          });
        const snapshot =
          this.closed || (abort.signal.aborted && abort.signal.reason !== "deadline")
            ? null
            : this.read(resolve);
        this.signal({
          kind: "refreshFinished",
          account,
          refresh: ticket.refreshId,
          outcome: committed ? outcome : "discarded",
        });
        if (committed && snapshot) this.publish(key, snapshot);
        return snapshot;
      })
      .finally(() => {
        cancel();
        abort.signal.removeEventListener("abort", onAbort);
        if (this.active.get(key)?.id === ticket.refreshId) this.active.delete(key);
      });
    const started: Flight = { id: ticket.refreshId, done, abort, readers: new Set() };
    this.active.set(key, started);
    return this.wait(started, key, manual, signal);
  }
  private wait(flight: Flight, key: string, manual: boolean, signal?: AbortSignal) {
    if (!manual) return flight.done;
    const reader = Symbol();
    flight.readers.add(reader);
    if (!signal) return flight.done;
    const detached = Promise.withResolvers<null>();
    const detach = () => {
      flight.readers.delete(reader);
      detached.resolve(null);
      if (flight.readers.size) return;
      for (const view of this.views) {
        const target = view.resolve();
        if (target && canonicalJson(target.binding) === key) return;
      }
      flight.abort.abort();
    };
    signal.addEventListener("abort", detach, { once: true });
    if (signal.aborted) detach();
    return Promise.race([flight.done, detached.promise]).finally(() => {
      flight.readers.delete(reader);
      signal.removeEventListener("abort", detach);
    });
  }
  async close() {
    this.closed = true;
    this.cancelAutomatic?.();
    this.cancelAutomatic = null;
    this.views.clear();
    const pending = [...this.active.values()];
    for (const job of pending) job.abort.abort();
    await Promise.allSettled(pending.map((job) => job.done));
  }
}
