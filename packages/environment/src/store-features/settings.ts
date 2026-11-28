import { markStartupDetail } from "../capture-timing";
import { settingTables } from "../setting-store";
import type { StoreFeature } from "./types";
export const settings = {
  schema: {
    order: 20,
    run(db) {
      db.exec(settingTables);
      markStartupDetail("db.settings");
    },
  },
} satisfies StoreFeature;
