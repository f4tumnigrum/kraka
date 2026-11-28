import { ExecutorTools } from "../executor-tools";
import type { WithServices } from "./types";

export const executorTools: WithServices<{ executorTools: ExecutorTools }> = {
  schema: {
    order: 35,
    run(db) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS executor_tool_bindings(thread TEXT NOT NULL, epoch INTEGER NOT NULL, data TEXT NOT NULL, principal TEXT, PRIMARY KEY(thread,epoch))",
      );
    },
  },
  services: {
    order: 35,
    create(store) {
      return { executorTools: new ExecutorTools(store) };
    },
  },
};
