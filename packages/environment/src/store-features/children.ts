import { childTables, ChildTransfers } from "../child-transfer-store";
import type { WithServices } from "./types";

export const children: WithServices<{ childTransfers: ChildTransfers }> = {
  schema: {
    order: 35,
    run(db) {
      db.exec(childTables);
    },
  },
  services: {
    order: 35,
    create(store) {
      return { childTransfers: new ChildTransfers(store) };
    },
  },
};
