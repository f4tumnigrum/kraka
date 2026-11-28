import { RoundSchema, CommandIdSchema } from "@kraka/protocol";
import * as v from "valibot";
import type { WriterFeature } from "./types";
export const inputs = {
  register({ store, replay, inspections, schedule }) {
    const pending = store.db
      .query<{ data: string }, []>(
        "SELECT r.data FROM deliveries d JOIN rounds r ON r.id=d.round WHERE (d.pending=1 OR (json_extract(r.data,'$.attempt.phase.kind')='unobserved' AND json_extract(d.frozen,'$.target.family')='codex' AND d.id=json_extract(r.data,'$.attempt.deliveryId'))) AND d.round NOT IN (SELECT round FROM ready_dispatch)",
      )
      .all()
      .map(({ data }) => v.parse(RoundSchema, JSON.parse(data)));
    for (const round of pending) {
      if (
        replay &&
        round.attempt.phase.kind === "recovering" &&
        round.attempt.phase.action === "inspectInput"
      ) {
        const rows = inspections.get(round.threadId) ?? [];
        rows.push(round);
        inspections.set(round.threadId, rows);
      }
    }

    return () => {
      for (const round of pending)
        schedule(round.threadId, v.parse(CommandIdSchema, round.attempt.deliveryId));
    };
  },
} satisfies WriterFeature;
