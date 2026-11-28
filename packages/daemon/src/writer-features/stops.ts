import type { WriterFeature } from "./types";
import { OrdinaryStops } from "@kraka/environment";
import { markStartupDetail, type FirstSendStore } from "@kraka/environment";
export const stops = {
  open(store: FirstSendStore) {
    const stops = new OrdinaryStops(store);
    markStartupDetail("owner.stops");
    return { services: { stops } };
  },
} satisfies WriterFeature;
