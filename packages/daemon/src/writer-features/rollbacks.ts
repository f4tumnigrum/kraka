import { reconcileRollback } from "@kraka/environment";
import type { WriterFeature } from "./types";
export const rollbacks = {
  register({ store }) {
    return () => {
      for (const id of store.services.rollbacks.unfinished())
        void reconcileRollback({ operationId: id, writer: store });
    };
  },
  draining(store) {
    return store.services.rollbacks.active.values();
  },
} satisfies WriterFeature;
