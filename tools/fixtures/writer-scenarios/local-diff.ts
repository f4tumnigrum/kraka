import type { Scenario } from "./fixture";
import { readRound, type FirstSendStore } from "@kraka/environment";
import { join } from "node:path";
export const localDiff: Scenario = ({ state }) => {
  let openedStore: FirstSendStore | undefined;
  return {
    lifecycle: {
      opened(store) {
        openedStore = store;
      },
      update(event) {
        if (event.kind === "round.ended")
          process.send?.({
            event: "completed",
            roundId: event.roundId,
            threadId: openedStore && readRound(openedStore.db, event.roundId)?.threadId,
          });
      },
      browserFixture(path: string) {
        if (path === "/s15")
          return new Response('<!doctype html><script src="/s15-client.js"></script>', {
            headers: { "Content-Type": "text/html" },
          });
        if (path === "/s15-client.js")
          return new Response(Bun.file(join(state, "s15-client.js")), {
            headers: { "Content-Type": "application/javascript" },
          });
        return null;
      },
    },
  };
};
