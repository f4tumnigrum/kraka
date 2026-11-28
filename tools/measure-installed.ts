import { mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { confirmWriter } from "@kraka/environment";
import { openDeviceCredentials } from "../packages/cli-client/src";
import { commandId, connectDevice } from "./fixtures/paired-project";
import {
  releaseForRoot,
  installedDirectory,
  startInstalled,
  pairingRecord,
  runIdentity,
} from "./fixtures/installed";
import { withState } from "./fixtures/replay-process";
import { currentFootprint, noChildren } from "./measure-replay";
import { installArtifact, readArtifact, inspectArchive } from "./package-release";
import type { ReportBase } from "./perf";

export async function measureInstalled(
  base: ReportBase,
  root: string,
  nextBlock: () => Promise<void>,
) {
  const out = await mkdtemp(join(tmpdir(), "kraka-budget-release-"));
  try {
    const report =
      process.env.KRAKA_TEST_ARCHIVE && base.role === "candidate"
        ? await readArtifact(resolve(process.env.KRAKA_TEST_ARCHIVE))
        : await releaseForRoot(root, out);
    if (base.metric === "P8") {
      const checked = await inspectArchive(report);
      base.expected = { archives: 1 };
      base.actual = { archives: 1 };
      base.observations.push({ ...checked, target: report.target, archiveSha256: report.sha256 });
      base.samples.push({
        series: "download",
        unit: "MB",
        value: checked.archiveBytes / 1_000_000,
      });
      return { download: 1 };
    }
    const bin = await installArtifact(report, join(out, "prefix"));
    const idle = base.metric === "P2",
      count = idle ? 10 : 20;
    base.expected = { launches: count, accepted: count, cliVerified: count, joined: count };
    const counts = { launches: 0, accepted: 0, cliVerified: 0, joined: 0 };
    base.actual = counts;
    for (let i = 0; i < 10; i++) {
      await withState(async (dir) => {
        const site = await installedDirectory(dir, bin);
        for (const series of idle ? ["idle"] : ["fresh", "reused"]) {
          const d = startInstalled(site);
          counts.launches++;
          try {
            const publication = await d.ready(),
              info = await d.next(pairingRecord);
            if (series !== "reused") await d.register();
            if ((await runIdentity(site)) !== publication.environmentId)
              throw Error("Installed CLI did not verify the same environment");
            counts.cliVerified++;
            const local = await openDeviceCredentials(join(site.client, "device.sqlite"));
            const id = commandId();
            let at: number;
            try {
              const device = local.load(publication.environmentId);
              if (device?.kind !== "registered") throw Error("Missing pinned identity");
              const client = await connectDevice(
                new URL(info.url).origin,
                device.identity,
                local,
                device.principal,
              );
              try {
                const receipt = await client.request({
                  method: "access.listSessions",
                  commandId: id,
                  payload: {},
                });
                if (
                  receipt.commandId !== id ||
                  receipt.kind !== "accepted" ||
                  receipt.result.kind !== "sessionsListed" ||
                  receipt.result.sessions.length !== 1 ||
                  receipt.result.sessions[0]?.connectionId !== client.configuration.connectionId
                )
                  throw Error("Missing matching signed acceptance");
                at = performance.now();
                counts.accepted++;
              } finally {
                client.close();
              }
            } finally {
              local.close();
            }
            const obs = {
              commandId: id,
              pid: d.child.pid,
              instanceId: publication.instanceId,
              series,
              target: report.target,
              archiveSha256: report.sha256,
            };
            if (idle) {
              await Bun.sleep(Math.max(0, Math.ceil(at + 60_000 - performance.now())));
              const check = async () => {
                if (
                  d.child.exitCode !== null ||
                  (await confirmWriter(publication.stateDirectory, performance.now() + 1000, true))
                    ?.instanceId !== publication.instanceId
                )
                  throw Error("Original daemon is no longer idle");
                noChildren(d.child.pid);
              };
              await check();
              const memory = await currentFootprint(d.child.pid);
              await check();
              base.observations.push({ ...obs, ...memory, elapsedMs: performance.now() - at });
              base.samples.push({ series, unit: "MiB", value: memory.mib });
            } else {
              base.observations.push({ ...obs, elapsedMs: at - d.start });
              base.samples.push({ series, unit: "ms", value: at - d.start });
            }
          } finally {
            await d.close();
            counts.joined++;
          }
        }
      });
      await nextBlock();
    }
    return idle ? { idle: 10 } : { fresh: 10, reused: 10 };
  } finally {
    await rm(out, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
  }
}
