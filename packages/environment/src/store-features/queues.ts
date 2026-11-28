import { markStartupDetail } from "../capture-timing";
import { recoverQueues } from "../input-store";
import type { StoreFeature } from "./types";
export const queues = {
  initialize: {
    order: 40,
    run(store, recovery) {
      recoverQueues(store, recovery);
      markStartupDetail("db.queueRecovery");
    },
  },
} satisfies StoreFeature;
