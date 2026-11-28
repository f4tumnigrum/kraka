import * as v from "valibot";
import { startWriter } from "../../packages/daemon/src/first-send";
import { peerFamily } from "./transition-family";
const state = process.argv[2];
if (!state || !process.send) throw Error("Missing crash writer channel");
const pending = new Map<string, ReturnType<typeof Promise.withResolvers<unknown>>>();
process.on("message", (raw: unknown) => {
  const reply = v.parse(v.object({ id: v.string(), value: v.unknown() }), raw);
  pending.get(reply.id)?.resolve(reply.value);
  pending.delete(reply.id);
});
const writer = await startWriter(state, null, {
  families: [
    peerFamily((peer, call) => {
      const id = crypto.randomUUID(),
        request = Promise.withResolvers<unknown>();
      pending.set(id, request);
      process.send?.({ id, peer, call });
      return request.promise;
    }),
  ],
});
if (writer.kind !== "ready") throw Error("Crash fixture did not acquire writer");
process.send({ publication: writer.instance });
