import type { WriterFeature } from "./types";
import { ExecutorInstances } from "../executor-instances";
import { markStartupDetail, type FirstSendStore } from "@kraka/environment";
export const executors = {
  open(store: FirstSendStore, families?: readonly import("@kraka/environment").ExecutorFamily[]) {
    const executors = new ExecutorInstances(store, families);
    markStartupDetail("owner.executors");
    return { services: { executors }, close: () => executors.close() };
  },
} satisfies WriterFeature;
