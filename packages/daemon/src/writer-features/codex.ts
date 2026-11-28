import type { WriterFeature } from "./types";
import { CodexInstances } from "../codex-instances";
import { markStartupDetail, type FirstSendStore } from "@kraka/environment";
export const codex = {
  open(store: FirstSendStore) {
    const codex = new CodexInstances(store);
    markStartupDetail("owner.executors");
    return { services: { codex }, close: () => codex.close() };
  },
} satisfies WriterFeature;
