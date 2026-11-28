import type { WriterFeature } from "./types";
export const diff = {
  register({ store }) {
    store.diffCleanup.registerRecovery(store.recovery);
  },
  draining(store) {
    return store.diffReads;
  },
} satisfies WriterFeature;
