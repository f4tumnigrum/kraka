import type { Scenario } from "./fixture";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { scenarioInput, serveSeed, recordFixtureFrame } from "../thread-seed";
export const resume: Scenario = ({ state, point }) => ({
  lifecycle: {
    opened: serveSeed,
    browserFixture(path: string) {
      if (path !== "/attention" && path !== "/reader.js") return null;
      const html = path === "/attention";
      return new Response(
        Bun.file(join(state, html ? "attention-page.html" : "attention-reader.js")),
        {
          headers: {
            "Content-Type": html ? "text/html" : "text/javascript",
            "Cache-Control": "no-store",
          },
        },
      );
    },
    threadCommand: scenarioInput,
    ...(point === "activity-ledger" ? { observeFrame: recordFixtureFrame } : {}),
    inspectPage(page: import("@kraka/protocol").SubscriptionPage) {
      if (!existsSync(join(state, "unknown-change"))) return page;
      return JSON.parse(
        JSON.stringify({ ...page, changes: [{ kind: "future.required" }, ...page.changes] }),
      );
    },
  },
});
