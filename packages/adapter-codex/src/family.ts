import { bindExecutorAdapter, type ExecutorFamily, type FamilyProbe } from "@kraka/environment";
import { canonicalJson } from "@kraka/protocol";
import * as v from "valibot";
import { createCodexAdapter } from "./adapter";
import { probeCodex, selectedModel, type CodexProbe } from "./discovery";

export const codexFamily: ExecutorFamily = {
  family: "codex",
  supports: (reg) => reg.driver.endpoint === null,
  async probe(reg, cwd, env, scope) {
    const executable = reg.driver.executable ?? "codex";
    if (reg.driver.configurationRoot) env.CODEX_HOME = reg.driver.configurationRoot;
    const launch = {
      executable:
        Bun.which(executable, { cwd, PATH: env.PATH ?? process.env.PATH ?? "" }) ?? executable,
      cwd,
      env,
    };
    const instance = { family: "codex" as const, instanceId: reg.instanceId };
    async function discover(previous?: CodexProbe, check = scope): Promise<FamilyProbe> {
      const probe = await probeCodex(
        reg,
        launch,
        previous,
        check?.now,
        check?.authorize,
        check?.expectedAccount,
        check?.verifiedCatalog,
      );
      return {
        ...probe,
        ...(probe.accountContext
          ? {
              sessionTransition: {
                account: probe.accountContext,
                continuationKey: canonicalJson([
                  reg.driver.historyRoot,
                  probe.nativeHome,
                  reg.driver.configurationRoot,
                ]),
                handoff: false,
                modelChange: null,
              },
            }
          : {}),
        bindingContext: canonicalJson({
          instance: reg.instanceId,
          credential: reg.credential,
          version: reg.version,
          account: probe.accountContext,
          historyRoot: reg.driver.historyRoot,
          nativeHome: probe.nativeHome,
          configurationRoot: reg.driver.configurationRoot,
          cwd,
        }),
        selectModel: (model) => selectedModel(probe.models, model),
        refresh: (next) => discover(probe, next),
        driver: (epoch) =>
          bindExecutorAdapter(
            instance,
            createCodexAdapter(instance, launch, probe, epoch, check?.now),
            (handle, setup) => ({
              requestOpen: (id) => !handle.lost && !handle.closed && handle.callbacks.has(id),
              interrupted() {
                const child = handle.rpc.child;
                return child.exitCode !== null || child.signalCode !== null
                  ? {
                      reason: "unexpectedExit",
                      message: "Codex process exited before a verified root end",
                    }
                  : {
                      reason: "unsafeToRetry",
                      message: "Codex delivery outcome could not be confirmed",
                    };
              },
              update(p, ids) {
                if (p.kind === "roundStarted")
                  return {
                    kind: "round.started",
                    ...ids,
                    nativeSessionId: handle.nativeSessionId,
                    nativeRootTurnId: p.nativeRootTurnId,
                    startedAt: p.at,
                    selectedMode: setup.permission.selected,
                    effectiveMode: setup.permission.selected,
                    effectivePolicy: handle.policy,
                    supportedModes: [setup.permission.selected],
                    enforcement: "native",
                  };
                if (p.kind !== "toolActivity") return null;
                const callId = p.callId;
                if (p.phase === "started")
                  return {
                    kind: "tool.started",
                    ...ids,
                    callId,
                    ...v.parse(v.object({ command: v.string() }), p.input),
                  };
                if (p.phase === "progress")
                  return {
                    kind: "tool.output",
                    ...ids,
                    callId,
                    ...v.parse(v.object({ text: v.string() }), p.output),
                  };
                const output = v.parse(
                  v.object({ text: v.nullable(v.string()), exitCode: v.nullable(v.number()) }),
                  p.output,
                );
                return {
                  kind: "tool.ended",
                  ...ids,
                  callId,
                  output: output.text,
                  exitCode: output.exitCode,
                };
              },
            }),
          ),
      };
    }
    return discover();
  },
};
