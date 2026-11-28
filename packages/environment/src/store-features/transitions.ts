import type { TransitionHost } from "../session-transition";
import type { StoreFeature } from "./types";
export const transitions = {
  services: {
    order: 35,
    create() {
      return {
        transitionDriver: { current: null as TransitionHost | null },
        transitionJobs: new Set<Promise<void>>(),
      };
    },
  },
  schema: {
    order: 35,
    run(db) {
      db.exec(`
    CREATE TABLE IF NOT EXISTS session_forks(child TEXT PRIMARY KEY,parent TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS fork_dispatch(child TEXT PRIMARY KEY,delivery TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS session_forks_parent ON session_forks(parent);
    CREATE TABLE IF NOT EXISTS imported_session_sources(thread TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_previews(id TEXT PRIMARY KEY,actor TEXT NOT NULL,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_switches(thread TEXT NOT NULL,operation TEXT NOT NULL,data TEXT NOT NULL,busy INTEGER NOT NULL,PRIMARY KEY(thread,operation));
    CREATE UNIQUE INDEX IF NOT EXISTS session_switch_busy ON session_switches(thread) WHERE busy=1;
    CREATE TABLE IF NOT EXISTS session_frozen(id TEXT PRIMARY KEY,data TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS session_clear(thread TEXT NOT NULL,delivery TEXT PRIMARY KEY,data TEXT NOT NULL,fresh INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS session_clear_thread ON session_clear(thread);
  `);
    },
  },
} satisfies StoreFeature;
