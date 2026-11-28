import { readManaged } from "@kraka/environment";
import type { WriterFeature } from "./types";
export const worktrees = {
  register({ store, resume }) {
    return () => {
      for (const { id } of store.db
        .query<{ id: string }, []>(
          "SELECT id FROM managed_worktrees WHERE unfinished=1 UNION SELECT worktree AS id FROM ready_dispatch",
        )
        .all()) {
        const m = readManaged(store.db, id);
        if (m) resume(m);
      }
    };
  },
} satisfies WriterFeature;
