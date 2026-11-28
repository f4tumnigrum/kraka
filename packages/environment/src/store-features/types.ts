import type { Database } from "bun:sqlite";
import type { FirstSendStore } from "../first-send-store";
import type { RecoveryScope } from "../input-store";

// Schema and initialization hooks run inside the single openStore transaction.
export interface StoreFeature {
  schema?: { order: number; afterJournal?: boolean; run(db: Database): void };
  services?: { order: number; create(store: FirstSendStore): object };
  initialize?: { order: number; run(store: FirstSendStore, recovery?: RecoveryScope): void };
}

export interface WithServices<S extends object> extends StoreFeature {
  services: { order: number; create(store: FirstSendStore): S };
}
