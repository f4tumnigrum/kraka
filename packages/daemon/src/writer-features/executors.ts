import type { WriterFeature } from "./types";
import { ExecutorInstances } from "../executor-instances";
import { markStartupDetail, type FirstSendStore } from "@kraka/environment";
export const executors = {
  open(store: FirstSendStore) {
    const executors = new ExecutorInstances(store);
    markStartupDetail("owner.executors");
    return { services: { executors }, close: () => executors.close() };
  },
} satisfies WriterFeature;
