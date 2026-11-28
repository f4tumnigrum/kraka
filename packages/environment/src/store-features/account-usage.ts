import { AccountUsageStore, accountUsageTables } from "../account-usage";
import type { WithServices } from "./types";
export const accountUsage: WithServices<{
  accountUsage: AccountUsageStore;
  quotaReads: Set<Promise<unknown>>;
}> = {
  schema: {
    order: 25,
    run(db) {
      db.exec(accountUsageTables);
    },
  },
  services: {
    order: 25,
    create(store) {
      return { accountUsage: new AccountUsageStore(store.db), quotaReads: new Set() };
    },
  },
};
