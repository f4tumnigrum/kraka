import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { inspectInstancePublication } from "@kraka/environment";
export async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: { "state-dir": { type: "string" }, json: { type: "boolean" } },
    allowPositionals: false,
  });
  if (!values["state-dir"] || !values.json) throw Error("Expected instance --state-dir DIR --json");
  const observed = await inspectInstancePublication(resolve(values["state-dir"]));
  if (observed === "unconfirmed")
    throw Error("Writer present or inaccessible; ownership unconfirmed");
  console.log(JSON.stringify(observed === "stopped" ? null : observed));
}
