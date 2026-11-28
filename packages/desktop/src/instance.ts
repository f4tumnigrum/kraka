import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { createInterface } from "node:readline";
import * as v from "valibot";
import { EnvironmentIdSchema, HostInstanceIdSchema } from "@kraka/protocol";
import { localEnvironment } from "./bridge";

const identity = v.object({
  pid: v.number(),
  environmentId: EnvironmentIdSchema,
  instanceId: HostInstanceIdSchema,
  endpoint: v.string(),
});
export function desktopInstances(executable: string, stateDir: string) {
  let owned: { instance: v.InferOutput<typeof identity>; stop(): Promise<void> } | null = null;
  const read = async () =>
    v.parse(
      v.nullable(identity),
      JSON.parse(
        (
          await promisify(execFile)(executable, ["instance", "--state-dir", stateDir, "--json"], {
            timeout: 15000,
          })
        ).stdout,
      ),
    );
  async function start(): Promise<"running" | "externallyOwned"> {
    const child = spawn(executable, ["start", "--state-dir", stateDir, "--print-pairing"], {
      stdio: ["pipe", "pipe", "ignore"],
    });
    const exit = once(child, "close");
    void exit.catch(() => {});
    const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
    try {
      const [line] = await Promise.race([
        once(lines, "line"),
        exit.then(() => {
          throw Error("Daemon exited before readiness");
        }),
      ]);
      const first = v.parse(
        v.object({ kind: v.picklist(["ready", "existingInstance"]), publication: identity }),
        JSON.parse(line),
      );
      const actual = await read();
      if (
        !actual ||
        actual.instanceId !== first.publication.instanceId ||
        actual.pid !== first.publication.pid
      )
        throw Error("Unconfirmed local daemon");
      if (first.kind === "existingInstance") return "externallyOwned";
      if (child.pid !== actual.pid) throw Error("Unexpected child identity");
      const handle = {
        instance: actual,
        async stop() {
          child.kill();
          await exit;
        },
      };
      owned = handle;
      void exit.finally(() => {
        if (owned === handle) owned = null;
      });
      return "running";
    } catch (e) {
      child.kill();
      await exit;
      throw e;
    } finally {
      lines.close();
      child.stdout.resume();
    }
  }
  let pending = Promise.resolve<"running" | "externallyOwned" | "stopped">("stopped");
  return {
    read,
    async close() {
      await pending.catch(() => {});
      if (owned) await localEnvironment("stopOwned", await read(), owned, start);
    },
    action(action: "status" | "start" | "stopOwned") {
      const run = pending
        .catch(() => "stopped")
        .then(async () => localEnvironment(action, await read(), owned, start));
      pending = run;
      return run;
    },
  };
}
