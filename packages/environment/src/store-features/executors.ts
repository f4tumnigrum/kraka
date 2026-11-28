import { markStartupDetail } from "../capture-timing";
import { executorTables } from "../executor-registry";
import type { StoreFeature } from "./types";
export const executors = {
  initialize: {
    order: 30,
    run(store) {
      store.db.exec(executorTables);
      markStartupDetail("db.executors");
    },
  },
} satisfies StoreFeature;
