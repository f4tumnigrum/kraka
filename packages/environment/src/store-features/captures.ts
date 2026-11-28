import { markStartupDetail } from "../capture-timing";
import { RoundCaptures } from "../capture-store";
import { openCaptureStorage } from "../capture-storage";
import type { WithServices } from "./types";
type Services = { captures: RoundCaptures };
export const captures: WithServices<Services> = {
  services: {
    order: 30,
    create(store) {
      return { captures: new RoundCaptures(store) };
    },
  },
  initialize: {
    order: 20,
    run(store) {
      openCaptureStorage(store.db);
      markStartupDetail("db.captures");
    },
  },
};
