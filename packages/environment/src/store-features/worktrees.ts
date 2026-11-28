import { markStartupDetail } from "../capture-timing";
import { worktreeTables } from "../worktree-storage";
import type { StoreFeature } from "./types";
export const worktrees = {
  schema: {
    order: 10,
    run(db) {
      db.exec(worktreeTables);
      markStartupDetail("db.worktrees");
    },
  },
} satisfies StoreFeature;
