import * as v from "valibot";
import { appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { peerState } from "./transition-host";
const [dir, instance] = process.argv.slice(2);
if (!dir || !instance || !process.send) throw Error("Missing peer arguments");
const state = peerState(instance),
  journal = join(dir, instance + ".jsonl");
let drop = false,
  sessionSerial = 0;
const native = new Set([state.nativeSession]);
const request = v.object({
  v: v.literal(1),
  id: v.string(),
  call: v.record(v.string(), v.unknown()),
});
let inputSeen = Promise.withResolvers<void>();
process.on("message", async (raw: unknown) => {
  const { id, call } = v.parse(request, raw);
  const save = () => appendFileSync(journal, JSON.stringify(call) + "\n");
  try {
    let value: unknown;
    switch (call.kind) {
      case "waitInput":
        await inputSeen.promise;
        value = true;
        break;
      case "fence":
        value = existsSync(journal)
          ? readFileSync(journal, "utf8")
              .trimEnd()
              .split("\n")
              .map((l) => JSON.parse(l))
          : [];
        break;
      case "declare":
        value = state;
        break;
      case "revise": {
        const patch = v.parse(
          v.object({
            available: v.optional(v.boolean()),
            handoff: v.optional(v.boolean()),
            live: v.optional(v.boolean()),
            drop: v.optional(v.boolean()),
          }),
          call,
        );
        if (patch.drop !== undefined) drop = patch.drop;
        else Object.assign(state, patch, { revision: state.revision + 1 });
        value = state;
        break;
      }
      case "handle":
      case "open": {
        const resume = v.parse(v.nullable(v.string()), call.resume);
        if (resume !== null && !native.has(resume)) throw Error("Foreign native session");
        value = resume ?? instance + "-" + ++sessionSerial;
        native.add(String(value));
        save();
        break;
      }
      case "subscribe":
      case "input":
        if (call.kind === "input") inputSeen.resolve();
        if (!native.has(String(call.nativeSessionId))) throw Error("Unknown session");
        save();
        value = true;
        break;
      case "invoke": {
        if (!native.has(String(call.nativeSessionId))) throw Error("Unknown session");
        const cmd = v.parse(
          v.object({
            kind: v.string(),
            request: v.optional(v.object({ kind: v.string() })),
            action: v.optional(v.string()),
          }),
          call.cmd,
        );
        save();
        if (cmd.request?.kind === "handoff" && state.handoff) {
          if (drop) throw Error("Reply lost after commit");
          value = "injected";
        } else if (cmd.request?.kind === "changeModel") {
          value = "changed";
        } else if (cmd.action === "clear") {
          value = instance + "-empty-" + ++sessionSerial;
          native.add(String(value));
        } else throw Error("Unsupported request");
        break;
      }
      default:
        throw Error("Unknown peer request");
    }
    process.send?.({ v: 1, id, value });
  } catch (e) {
    process.send?.({ v: 1, id, error: String(e) });
  }
});
process.on("disconnect", () => process.exit(0));
process.send({ v: 1, ready: true });
