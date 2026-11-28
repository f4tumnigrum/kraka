import { markStartupDetail } from "../capture-timing";
import { DiffCleanup, diffCleanupTables } from "../diff-cleanup";
import { writerGitPaths } from "../private-git";
import type { WithServices } from "./types";
type Services = {
  gitPaths: ReturnType<typeof writerGitPaths>;
  diffCleanup: DiffCleanup;
  diffReads: Set<Promise<void>>;
};
export const diff: WithServices<Services> = {
  schema: {
    order: 40,
    run(db) {
      db.exec(diffCleanupTables);
      markStartupDetail("db.diff");
    },
  },
  services: {
    order: 10,
    create(store) {
      const { db, writer } = store;
      const gitPaths = writerGitPaths(writer.stateDirectory, writer.environmentId);
      return {
        gitPaths,
        diffCleanup: new DiffCleanup(db, gitPaths),
        diffReads: new Set<Promise<void>>(),
      };
    },
  },
};
