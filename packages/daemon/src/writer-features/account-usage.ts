import type { WriterFeature } from "./types";
export const accountUsage = {
  draining(store) {
    return store.services.quotaReads;
  },
} satisfies WriterFeature;
