import type { WriterFeature } from "./types";

export const forge = {
  draining: (store) => store.services.forge.stop(),
} satisfies WriterFeature;
