import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { followThread } from "@kraka/cli-client";
import { readInstancePublication } from "@kraka/environment";
import { ThreadIdSchema } from "@kraka/protocol";
import * as v from "valibot";
export async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      "state-dir": { type: "string" },
      thread: { type: "string" },
      jsonl: { type: "boolean" },
    },
    allowPositionals: false,
  });
  if (!values["state-dir"] || !values.jsonl)
    throw Error("Expected thread follow --state-dir DIR --thread T --jsonl");
  const thread = v.parse(ThreadIdSchema, values.thread);
  const publication = await readInstancePublication(resolve(values["state-dir"]));
  if (!publication) throw Error("Environment unavailable");
  const scope = new AbortController();
  const cancel = () => scope.abort();
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    await followThread(publication.environmentId, publication.endpoint, thread, scope.signal);
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}
