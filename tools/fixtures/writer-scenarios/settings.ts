import type { Scenario } from "./fixture";
import { settingPeer } from "../setting-peer";
import type { FirstSendStore } from "@kraka/environment";
export const settings: Scenario = ({ state }) => {
  let openedStore: FirstSendStore | undefined;
  return {
    lifecycle: {
      opened(store) {
        openedStore = store;
      },
      settingReply: settingPeer(state, () => {
        if (!openedStore) throw Error("Writer not open");
        return openedStore;
      }),
      async beforeDispatch(threadId) {
        process.send?.({ event: "dispatch", threadId });
      },
      update(event) {
        if (event.kind === "round.ended")
          process.send?.({ event: "ended", roundId: event.roundId });
      },
    },
  };
};
