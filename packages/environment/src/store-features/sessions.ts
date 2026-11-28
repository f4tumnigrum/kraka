import { markStartupDetail } from "../capture-timing";
const sessionTables = `CREATE TABLE IF NOT EXISTS codex_bindings(thread TEXT NOT NULL,epoch INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,epoch)); CREATE TABLE IF NOT EXISTS round_stops(thread TEXT NOT NULL,command TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(thread,command));`;
import type { StoreFeature } from "./types";
export const sessions = {
  schema: {
    order: 30,
    run(db) {
      db.exec(sessionTables);
      markStartupDetail("db.sessions");
    },
  },
} satisfies StoreFeature;
