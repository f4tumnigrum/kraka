import { WriterExecutorRegistry } from "../executor-registry";
import { InstanceLogins, loginTable } from "../instance-login";
import type { WithServices } from "./types";
export const logins: WithServices<{ logins: InstanceLogins }> = {
  initialize: {
    order: 32,
    run(store) {
      store.services.logins.recover();
    },
  },
  schema: {
    order: 31,
    run(db) {
      db.exec(loginTable);
    },
  },
  services: {
    order: 31,
    create(store) {
      const registry = new WriterExecutorRegistry(store);
      return { logins: new InstanceLogins(store.db, (id) => registry.current(id)) };
    },
  },
};
