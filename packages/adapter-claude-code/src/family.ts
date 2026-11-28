import { bindExecutorAdapter, type ExecutorFamily, type FamilyProbe } from "@kraka/environment";
import { AttemptIdSchema, canonicalJson } from "@kraka/protocol";
import * as v from "valibot";
import { createClaudeCodeAdapter } from "./adapter";
import { within } from "./session";

export const claudeCodeFamily: ExecutorFamily = {
  family: "claude-code",
  supports: (reg) => reg.driver.endpoint === null,
  async probe(reg, cwd, variables) {
    const environment = {
      ...variables,
      ...(reg.driver.configurationRoot ? { CLAUDE_CONFIG_DIR: reg.driver.configurationRoot } : {}),
    };
    const instance = { family: "claude-code" as const, instanceId: reg.instanceId };
    async function discover(): Promise<FamilyProbe> {
      const now = Date.now(),
        launch = {
          executable: reg.driver.executable ?? "claude",
          instanceId: reg.instanceId,
          environment,
          capabilityVersion: now,
        };
      const adapter = createClaudeCodeAdapter(launch);
      const declaration = await adapter.capabilities(instance);
      if (declaration.kind !== "ok") throw Error("Missing Claude declaration");
      let verifiedCli: { executable: string; version: string } | undefined;
      let binaryVersion: string | null = null,
        sdkVersion: string | null = null;
      let models: FamilyProbe["models"] = null;
      const ready = { state: "yes", verifiedAt: now } as const;
      const d = declaration.value;
      d.readiness = { ...d.readiness, configured: ready };
      const configModel = reg.model ?? { id: "default", options: {} };
      const opened = await adapter.open({
        instance,
        attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
        resume: null,
        setup: {
          workingDirectory: cwd,
          additionalDirectories: [],
          environment,
          model: configModel,
          permission: reg.permission,
        },
      });
      if (opened.kind === "ok") {
        const session = opened.value;
        try {
          binaryVersion = session.handle.cliVersion;
          verifiedCli = { executable: session.handle.executable, version: binaryVersion };
          sdkVersion = session.handle.sdkVersion;
          d.readiness = { ...d.readiness, installed: ready };
          const info = await within(session.handle.connection.initializationResult(), 10000);
          const rows = info.models.map((m) => ({
            id: m.value,
            slug: m.resolvedModel ?? m.value,
            displayName: m.displayName,
            isDefault: m.value === reg.model?.id,
            options: {},
          }));
          models = { checkedAt: now, models: rows };
          const authenticated = !!(
            (info.account.tokenSource && info.account.tokenSource !== "none") ||
            info.account.email ||
            (info.account.apiKeySource && info.account.apiKeySource !== "none")
          );
          const model = rows.some((m) => !reg.model || m.id === reg.model.id);
          d.readiness = {
            ...d.readiness,
            authenticated: authenticated ? ready : d.readiness.authenticated,
            model: model ? ready : d.readiness.model,
            operation: ready,
          };
        } catch {
          /* Keep observed layers when the control channel closes during discovery. */
        } finally {
          await adapter.close(session, "finished");
        }
      }
      return {
        declaration: d,
        binaryVersion,
        models,
        compatibilityAdvisory: null,
        versionAdvisory: sdkVersion ? "Claude Agent SDK " + sdkVersion : null,
        retryAt: now + 60000,
        bindingContext: canonicalJson({
          instance: reg.instanceId,
          version: reg.version,
          credential: reg.credential,
          cwd,
          configurationRoot: reg.driver.configurationRoot,
          historyRoot: reg.driver.historyRoot,
        }),
        selectModel(request) {
          const selected =
            request ??
            reg.model ??
            (models?.models[0] ? { id: models.models[0].id, options: {} } : null);
          return selected &&
            !Object.keys(selected.options).length &&
            models?.models.some((m) => m.id === selected.id)
            ? selected
            : null;
        },
        refresh: discover,
        driver: (previousEpoch) =>
          bindExecutorAdapter(
            instance,
            createClaudeCodeAdapter({
              ...launch,
              previousEpoch,
              ...(verifiedCli && { verifiedCli }),
            }),
            (h, setup) => ({
              requestOpen: (id) => !h.closed && !h.failure && h.approvals.pending.has(id),
              interrupted: () => ({
                reason: h.failure?.kind ?? "unsafeToRetry",
                message: "Claude SDK stream ended before the matched root",
              }),
              update(p, ids) {
                if (p.kind === "roundStarted" && h.init)
                  return {
                    kind: "round.started",
                    ...ids,
                    nativeSessionId: h.binding.nativeSessionId,
                    nativeRootTurnId: p.nativeRootTurnId,
                    startedAt: p.at,
                    selectedMode: setup.permission.selected,
                    effectiveMode: setup.permission.selected,
                    enforcement: "native",
                    supportedModes: ["ask", "edits", "open"],
                  };
                if (p.kind !== "toolActivity") return null;
                if (
                  p.phase === "started" &&
                  p.input &&
                  typeof p.input === "object" &&
                  "command" in p.input &&
                  typeof p.input.command === "string"
                )
                  return {
                    kind: "tool.started",
                    ...ids,
                    callId: p.callId,
                    command: p.input.command,
                  };
                if (
                  p.phase === "ended" &&
                  p.output &&
                  typeof p.output === "object" &&
                  "text" in p.output &&
                  typeof p.output.text === "string"
                )
                  return {
                    kind: "tool.ended",
                    ...ids,
                    callId: p.callId,
                    output: p.output.text,
                    exitCode: null,
                  };
                return null;
              },
            }),
          ),
      };
    }
    return discover();
  },
};
