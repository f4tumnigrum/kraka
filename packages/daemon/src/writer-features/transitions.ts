import type { WriterFeature } from "./types";
export const transitions = {
  draining: (store) => store.services.transitionJobs,
} satisfies WriterFeature;
