import { join } from "node:path";
import * as v from "valibot";
import { DevicePrincipalSchema, EnvironmentIdentitySchema, canonicalJson } from "@kraka/protocol";
import { openDeviceCredentials } from "../packages/cli-client/src";
import { connectDevice, commandId, type Client } from "./fixtures/paired-project";
import { entry, terminate, within } from "./fixtures/replay-process";

export const ownerProvisioner = "tools/fixtures/provision-owner.ts";
export async function sampleOwnerPair(
  root: string,
  dir: string,
  counts: Record<string, number>,
  observe: (series: "fresh" | "reused", elapsed: number, command: string) => void,
) {
  const setup = Bun.spawnSync([process.execPath, join(root, ownerProvisioner), dir], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10000,
  });
  if (setup.exitCode !== 0 || setup.signalCode)
    throw Error(`Disposable owner setup failed: ${setup.stderr}`);
  const { identity, principal } = v.parse(
    v.object({ identity: EnvironmentIdentitySchema, principal: DevicePrincipalSchema }),
    JSON.parse(setup.stdout.toString()),
  );
  const device = await openDeviceCredentials(join(dir, "client", "device.sqlite"));
  try {
    for (const series of ["fresh", "reused"] as const) {
      const argv = [
        process.execPath,
        join(root, entry),
        "access",
        "serve",
        "--state-dir",
        join(dir, "host"),
        "--port",
        "0",
      ];
      const started = performance.now();
      const child = Bun.spawn(argv, { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
      counts.launches = (counts.launches ?? 0) + 1;
      const errors = new Response(child.stderr).text();
      let client: Client | undefined;
      try {
        const reader = child.stdout.getReader();
        let line = "";
        while (!line.includes("\n")) {
          const value = await within(reader.read(), 5000, "Authorized daemon ready");
          if (value.done) throw Error(`Missing daemon ready line: ${await errors}`);
          line += new TextDecoder().decode(value.value);
        }
        const ready = v.parse(
          v.object({ origin: v.string(), identity: EnvironmentIdentitySchema }),
          JSON.parse(line),
        );
        if (canonicalJson(ready.identity) !== canonicalJson(identity))
          throw Error("Pin changed on launch");
        client = await connectDevice(ready.origin, identity, device, principal);
        const command = commandId();
        const receipt = await client.request({
          method: "access.listSessions",
          commandId: command,
          payload: {},
        });
        const elapsed = performance.now() - started;
        if (
          receipt.commandId !== command ||
          receipt.kind !== "accepted" ||
          receipt.result.kind !== "sessionsListed" ||
          receipt.result.sessions.length !== 1 ||
          receipt.result.sessions[0]?.principal.id !== principal.id ||
          receipt.result.sessions[0]?.connectionId !== client.configuration.connectionId
        )
          throw Error("Unexpected authorized command receipt");
        counts.accepted = (counts.accepted ?? 0) + 1;
        observe(series, elapsed, command);
      } finally {
        client?.close();
        await terminate(child);
        await errors;
        counts.joined = (counts.joined ?? 0) + 1;
      }
      if (
        child.exitCode !== 0 &&
        child.signalCode !== "SIGTERM" &&
        !(process.platform === "win32" && child.exitCode === 1)
      )
        throw Error("Authorized daemon did not exit cleanly");
    }
  } finally {
    device.close();
  }
}
