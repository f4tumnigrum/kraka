import { createInterface } from "node:readline";
import * as v from "valibot";
import { openBrowserFixture } from "./browser";
import { invite } from "./paired-project";
const emit = (id: string, value: unknown) =>
  process.stdout.write(`${JSON.stringify({ id, value })}\n`);
const f = await openBrowserFixture({
  stateDir: "/work/state",
  profileDir: "/work/profile",
  network: "routed",
});
const input = createInterface({ input: process.stdin });
let closeId: string | undefined;
try {
  emit("ready", { origin: f.origin, identity: f.project.identity, projectId: f.project.projectId });
  for await (const line of input) {
    const { id, op } = v.parse(
      v.object({
        id: v.string(),
        op: v.picklist(["pair", "seed", "route", "disconnect", "restore", "lan", "close"]),
      }),
      JSON.parse(line),
    );
    if (op === "close") {
      closeId = id;
      break;
    }
    try {
      const value =
        op === "seed" ? await invite(f.project.owner, f.project.projectId) : await f[op]();
      emit(id, value);
    } catch (error) {
      process.stdout.write(`${JSON.stringify({ id, error: String(error) })}\n`);
    }
  }
} finally {
  input.close();
  await f.close();
  if (closeId) emit(closeId, true);
}
