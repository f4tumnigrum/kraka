import { RollbackOperationStore, rollbackTables } from "../rollback-store";
import { publicationTables } from "../rollback-publications";
import type { WithServices } from "./types";
export const rollbacks: WithServices<{ rollbacks: RollbackOperationStore }> = {
  schema: {
    order: 50,
    run(db) {
      db.exec(rollbackTables + publicationTables);
    },
  },
  services: {
    order: 50,
    create(store) {
      return { rollbacks: new RollbackOperationStore(store) };
    },
  },
};
