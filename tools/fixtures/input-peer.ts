import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  NativeSessionIdSchema,
} from "@kraka/protocol";
import * as v from "valibot";

const state = process.argv[2];
if (!state) throw Error("Expected peer directory");
const observation = v.object({
  step: v.picklist(["write", "start", "steer", "handoff"]),
  attemptId: AttemptIdSchema,
  deliveryId: DeliveryIdSchema,
  messageId: MessageIdSchema,
  sessionId: NativeSessionIdSchema,
  data: v.unknown(),
});
const dir = state;
const pickedUp = new Set<string>();
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    const item = v.parse(observation, await req.json());
    async function observe(step: string) {
      appendFileSync(join(dir, "peer.jsonl"), JSON.stringify({ ...item, step }) + "\n");
      const gate = join(dir, "hold-" + step);
      while (existsSync(gate)) await Bun.sleep(3);
    }
    if (item.step === "write") {
      await observe("beforeWrite");
      const key = JSON.stringify([item.attemptId, item.deliveryId]);
      if (!existsSync(join(dir, "dedup")) || !pickedUp.has(key)) {
        pickedUp.add(key);
        appendFileSync(
          join(dir, "peer.jsonl"),
          JSON.stringify({ ...item, step: "externalEffect" }) + "\n",
        );
      }
      await observe("afterWrite");
      await observe("receipt");
    } else await observe(item.step);
    return Response.json({ sessionId: item.sessionId, itemId: "native-" + item.deliveryId });
  },
});
writeFileSync(join(dir, "peer.url"), server.url.origin);
process.once("SIGTERM", () => {
  void server.stop(true);
  process.exit(0);
});
