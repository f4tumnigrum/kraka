import { isAbsolute } from "node:path";
import { bindExecutorAdapter, type ExecutorFamily, type FamilyProbe } from "@kraka/environment";
import { canonicalJson } from "@kraka/protocol";
import { createPiAdapter } from "./adapter";
import { probePi, type PiProbe } from "./discovery";
import type { PiLaunch } from "./launch";

export const piFamily: ExecutorFamily = {
  family: "pi",
  supports: (reg) =>
    reg.driver.endpoint === null &&
    !!reg.driver.configurationRoot &&
    isAbsolute(reg.driver.configurationRoot) &&
    !!reg.driver.historyRoot &&
    isAbsolute(reg.driver.historyRoot),
  async probe(reg, cwd, env) {
    const { configurationRoot, historyRoot } = reg.driver;
    if (!configurationRoot || !historyRoot) throw Error("Pi needs account and session directories");
    const executable = reg.driver.executable ?? "pi";
    const launch: PiLaunch = {
      executable:
        Bun.which(executable, { cwd, PATH: env.PATH ?? process.env.PATH ?? "" }) ?? executable,
      accountDirectory: configurationRoot,
      sessionDirectory: historyRoot,
      cwd,
      env,
      toolPolicy: "builtin",
    };
    const instance = { family: "pi" as const, instanceId: reg.instanceId };
    async function discover(previous?: PiProbe): Promise<FamilyProbe> {
      const probe = await probePi(launch, reg.permission, reg.model?.id ?? null, previous);
      return {
        ...probe,
        versionAdvisory: null,
        retryAt: Date.now() + 60_000,
        bindingContext: canonicalJson({
          instance,
          version: reg.version,
          credential: reg.credential,
          executable: launch.executable,
          cwd,
          configurationRoot,
          historyRoot,
        }),
        refresh: () => discover(probe),
        selectModel(selection) {
          if (selection && Object.keys(selection.options).length) return null;
          const model = selection
            ? probe.models?.models.find((m) => m.id === selection.id)
            : probe.models?.models.find((m) => m.isDefault);
          return model ? { id: model.id, options: {} } : null;
        },
        driver: (epoch) =>
          bindExecutorAdapter(
            instance,
            createPiAdapter(instance, launch, probe, epoch),
            (handle, setup) => ({
              requestOpen: (id) => handle.hasCallback(id),
              update(p, target) {
                if (p.kind !== "roundStarted") return null;
                return {
                  kind: "round.started",
                  ...target,
                  startedAt: p.at,
                  nativeSessionId: handle.nativeSessionId,
                  nativeRootTurnId: p.nativeRootTurnId,
                  selectedMode: setup.permission.selected,
                  effectiveMode: setup.permission.selected,
                  supportedModes: (["ask", "edits", "open"] as const).filter((m) =>
                    probe.declaration.permission.modes.includes(m),
                  ),
                  enforcement: "adapter",
                };
              },
            }),
          ),
      };
    }
    return discover();
  },
};
