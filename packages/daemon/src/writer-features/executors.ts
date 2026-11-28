import type { WriterFeature } from "./types";
import { ExecutorInstances } from "../executor-instances";
import { markStartupDetail, type FirstSendStore } from "@kraka/environment";
export const executors = {
  open(
    store: FirstSendStore,
    clock?: import("../instance-login").LoginClock,
    families?: readonly import("@kraka/environment").ExecutorFamily[],
  ) {
    const executors = new ExecutorInstances(store, families, clock);
    markStartupDetail("owner.executors");
    return { services: { executors }, close: () => executors.close() };
  },
} satisfies WriterFeature;
