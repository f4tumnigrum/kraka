import { RoundSchema, CommandIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import type { WriterFeature } from "./types";
export const captures = {
  register({ store, schedule }) {
    const closing = store.db
      .query<{ data: string }, []>(
        "SELECT data FROM rounds WHERE json_extract(data,'$.attempt.phase.kind') NOT IN ('finished','endedEarly','notDelivered') AND json_extract(data,'$.attempt.phase.kind')='closing'",
      )
      .all()
      .map(({ data }) => v.parse(RoundSchema, JSON.parse(data)));
    store.captures.registerRecovery(closing);
    return () => {
      for (const round of closing)
        schedule(round.threadId, v.parse(CommandIdSchema, round.attempt.deliveryId));
    };
  },
} satisfies WriterFeature;
