import { ExecutorTools } from "../executor-tools";
import type { WithServices } from "./types";

export const executorTools: WithServices<{ executorTools: ExecutorTools }> = {
  schema: {
    order: 35,
    run(db) {
      db.exec(
        "CREATE TABLE IF NOT EXISTS executor_tool_grants(thread TEXT NOT NULL, epoch INTEGER NOT NULL, attempt TEXT NOT NULL, principal TEXT NOT NULL, PRIMARY KEY(thread,epoch)); CREATE TABLE IF NOT EXISTS executor_uploads(stream INTEGER PRIMARY KEY, transfer TEXT NOT NULL UNIQUE, attachment TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, thread TEXT NOT NULL, request TEXT NOT NULL)",
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
