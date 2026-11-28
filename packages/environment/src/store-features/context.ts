import * as v from "valibot";
import {
  ContextOperationSchema,
  type ContextOperationObservation,
  type ThreadId,
  type CapabilitySupport,
  type DeliveryId,
} from "@kraka/protocol";
import { transitionContextOperation } from "../context-operations";
import type { FirstSendStore } from "../first-send-store";
import type { ThreadSessionBinding } from "../executor-records";
import type { StoreFeature } from "./types";
export type ContextEndpoint = {
  binding: ThreadSessionBinding;
  support: CapabilitySupport;
  current(): boolean;
  invoke: (
    delivery: DeliveryId,
    instructions: string | null,
  ) => Promise<ContextOperationObservation>;
};
class ContextServices {
  readonly live = new Map<ThreadId, ContextEndpoint>();
  private readonly routes = new Map<DeliveryId, ContextEndpoint>();
  readonly active = new Set<Promise<void>>();
  constructor(readonly store: FirstSendStore) {}
  register(delivery: DeliveryId, endpoint: ContextEndpoint) {
    this.routes.set(delivery, endpoint);
  }
  detach(endpoint: ContextEndpoint) {
    for (const [delivery, route] of this.routes) {
      if (route !== endpoint) continue;
      this.observe(
        {
          action: "compact",
          threadId: endpoint.binding.threadId,
          deliveryId: delivery,
          state: { kind: "unknown", observedAt: Date.now() },
        },
        endpoint,
      );
      this.routes.delete(delivery);
    }
  }
  observe(result: ContextOperationObservation, endpoint?: ContextEndpoint) {
    if (
      endpoint &&
      (endpoint.binding.threadId !== result.threadId ||
        this.routes.get(result.deliveryId) !== endpoint)
    )
      return;
    this.store.db.transaction(() => {
      const row = this.store.db
        .query<{ data: string }, [string]>("SELECT data FROM sync_context_operations WHERE id=?")
        .get(result.deliveryId);
      if (!row) return;
      const current = v.parse(ContextOperationSchema, JSON.parse(row.data)),
        next = transitionContextOperation(current, result);
      if (next.kind === "ok" && next.value !== current) {
        this.store.sync.record([], { context: next.value });
        if (next.value.state.kind === "completed" || next.value.state.kind === "failed")
          this.routes.delete(result.deliveryId);
      }
    })();
    this.store.sync.notify();
  }
}
export const context = {
  services: {
    order: 34,
    create: (store: FirstSendStore) => ({ context: new ContextServices(store) }),
  },
  initialize: {
    order: 79,
    run(store) {
      for (const row of store.db
        .query<{ data: string }, []>(
          "SELECT data FROM sync_context_operations WHERE json_extract(data,'$.state.kind')='accepted'",
        )
        .all()) {
        const op = v.parse(ContextOperationSchema, JSON.parse(row.data));
        store.services.context.observe({
          ...op,
          state: { kind: "unknown", observedAt: Math.max(Date.now(), op.state.acceptedAt) },
        });
      }
    },
  },
} satisfies StoreFeature;
