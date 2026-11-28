import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as v from "valibot";
import { createReplayAdapter } from "@kraka/adapter-replay";
import {
  bindExecutorAdapter,
  openStore,
  openWriter,
  registerProject,
  readRound,
  savedBinding,
  type AdapterCommand,
  type AdapterCallResult,
  type AdapterSession,
  type AdapterInstance,
  type ActionPermit,
  type AdapterCapability,
  type InstanceServiceCommand,
  type InstanceServiceResult,
  type SessionInvocationResult,
  type ExecutorFamily,
  type FamilyProbe,
  type ProviderAdapter,
  type InvocationResult,
} from "@kraka/environment";
import {
  CommandIdSchema,
  PrincipalIdSchema,
  HostInstanceIdSchema,
  ExecutorInstanceIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  type AttemptId,
} from "@kraka/protocol";
import { ExecutorInstances } from "../executor-instances";
import { openAccessHost } from "../access";
import { threadWork } from "../thread-work";

const nativeSessionId = v.parse(NativeSessionIdSchema, "fixture-session");
const root = v.parse(NativeRootTurnIdSchema, "fixture-root");
const command = () => v.parse(CommandIdSchema, crypto.randomUUID());
async function testFamily(log: string[]) {
  const sample = await createReplayAdapter().capabilities({
    family: "replay",
    instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
  });
  if (sample.kind !== "ok") throw Error("Missing fixture declaration");
  const declaration = {
    ...sample.value,
    family: "pi" as const,
    matrix: { ...sample.value.matrix, readHistory: { kind: "native" as const } },
  };
  const family: ExecutorFamily = {
    family: "pi",
    supports: (r) => r.driver.endpoint === null,
    async probe(reg) {
      const probe: FamilyProbe = {
        declaration,
        bindingContext: reg.instanceId,
        retryAt: Date.now() + 60000,
        binaryVersion: null,
        models: null,
        compatibilityAdvisory: null,
        versionAdvisory: null,
        selectModel: () => ({ id: "test", options: {} }),
        refresh: async () => probe,
        driver(epoch) {
          const instance = { family: "pi" as const, instanceId: reg.instanceId };
          type Handle = {
            attempt: AttemptId;
            sent: ReturnType<typeof Promise.withResolvers<void>>;
            history: boolean;
          };
          type Session = AdapterSession<"pi", Handle>;
          async function invoke<C extends InstanceServiceCommand>(
            i: AdapterInstance<"pi">,
            p: ActionPermit<"pi", C["capability"]>,
            c: C,
          ): Promise<AdapterCallResult<InstanceServiceResult<C>>>;
          async function invoke<C extends AdapterCommand>(
            s: Session,
            p: ActionPermit<"pi", C["capability"]>,
            c: C,
          ): Promise<AdapterCallResult<SessionInvocationResult<C>>>;
          async function invoke(
            target: Session | AdapterInstance<"pi">,
            _p: ActionPermit<"pi", AdapterCapability>,
            c: AdapterCommand,
          ): Promise<
            AdapterCallResult<InvocationResult | InstanceServiceResult<InstanceServiceCommand>>
          > {
            if ("handle" in target) {
              if (c.kind === "deliverInput") {
                log.push(c.input.text);
                target.handle.sent.resolve();
                return { kind: "ok", value: { kind: "written", deliveryId: c.deliveryId } };
              }
              if (
                c.kind === "nativeAction" &&
                c.action === "readHistory" &&
                c.target === root &&
                target.handle.history
              ) {
                log.push("read original root");
                target.handle.sent.resolve();
                return { kind: "ok", value: { kind: "history", rows: [root], next: null } };
              }
            }
            return { kind: "rejected", reason: "unsupported", message: null };
          }
          const adapter: ProviderAdapter<"pi", Handle> = {
            capabilities: async () => ({ kind: "ok", value: declaration }),
            invoke,
            async open({ attemptId, resume }) {
              if (resume !== null && resume !== nativeSessionId)
                throw Error("Wrong native session");
              log.push(resume ?? "open");
              return {
                kind: "ok",
                value: {
                  ...instance,
                  epoch: epoch + 1,
                  nativeSessionId,
                  handle: {
                    attempt: attemptId,
                    sent: Promise.withResolvers<void>(),
                    history: resume !== null,
                  },
                },
              };
            },
            async *events(s) {
              await s.handle.sent.promise;
              const common = {
                ...instance,
                epoch: s.epoch,
                sessionId: nativeSessionId,
                eventId: "1",
              };
              const attemptId = s.handle.attempt;
              if (!s.handle.history)
                yield {
                  ...common,
                  payload: { kind: "roundStarted", attemptId, nativeRootTurnId: root, at: 10 },
                };
              else
                yield {
                  ...common,
                  payload: {
                    kind: "roundEnded",
                    attemptId,
                    nativeRootTurnId: root,
                    endedAt: 20,
                    endTimeEvidence: {
                      source: "environmentObserved",
                      executorEndedAt: null,
                      environmentObservedAt: 20,
                    },
                    outcome: { reason: "completed", nativeReason: null },
                  },
                };
            },
            async close() {
              return { kind: "ok", value: undefined };
            },
          };
          return bindExecutorAdapter(instance, adapter);
        },
      };
      return probe;
    },
  };
  return family;
}

test("a registered family dispatches a thread and recovers its original root after reopening the store", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kraka-family-"));
  const projectPath = join(dir, "project");
  mkdirSync(projectPath);
  const lock = await openWriter(
    dir,
    v.parse(HostInstanceIdSchema, crypto.randomUUID()),
    performance.now() + 1000,
  );
  if (lock.kind !== "writer") throw Error("Writer required");
  const host = await openAccessHost(dir);
  const actor = {
    id: v.parse(PrincipalIdSchema, "owner"),
    environmentId: lock.lease.environmentId,
    allows: () => true,
  };
  const log: string[] = [];
  const family = await testFamily(log);
  const open = () => {
    const store = openStore(lock.lease);
    const instances = new ExecutorInstances(store, [family]);
    const work = threadWork(store, host, actor, instances, null);
    return {
      store,
      instances,
      work,
      async close() {
        await work.close();
        await instances.close();
        store.db.close(true);
      },
    };
  };
  let site = open();
  try {
    const project = registerProject({
      transaction: site.store,
      environmentId: actor.environmentId,
      actor,
      commandId: command(),
      realPath: projectPath,
    });
    if (project.kind !== "accepted" || project.result.kind !== "projectRegistered")
      throw Error("Project registration failed");
    const projectId = project.result.project.id;
    const instanceId = v.parse(ExecutorInstanceIdSchema, "test-family");
    const registration = {
      family: "pi" as const,
      instanceId,
      displayName: "Fixture",
      enabled: true,
      driver: {
        executable: null,
        endpoint: null,
        configurationRoot: null,
        historyRoot: null,
        variables: {},
      },
      credential: null,
      model: null,
      permission: { ceiling: "ask" as const, selected: "ask" as const },
    };
    const ctx = () => ({ actor, commandId: command(), transaction: site.store });
    expect(
      site.instances.configure(ctx(), {
        expectedVersion: null,
        registration: { ...registration, family: "codex" },
      }),
    ).toMatchObject({ kind: "rejected", failure: { kind: "unsupported" } });
    expect(site.instances.configure(ctx(), { expectedVersion: null, registration })).toMatchObject({
      kind: "accepted",
    });
    const start = await site.work.startThread(actor, {
      commandId: command(),
      payload: {
        instanceId,
        projectId,
        worktreeId: null,
        content: { text: "fixture input", attachments: [], references: [] },
      },
    });
    if (start.kind !== "accepted" || start.result.kind !== "threadStarted")
      throw Error("Test thread was refused");
    const { roundId, threadId } = start.result;
    async function phase(kind: "unobserved" | "finished", act: () => void) {
      const seen = Promise.withResolvers<void>();
      const unsub = site.store.sync.subscribe(() => {
        if (readRound(site.store.db, roundId)?.attempt.phase.kind === kind) seen.resolve();
      });
      try {
        act();
        await seen.promise;
      } finally {
        unsub();
      }
    }
    await phase("unobserved", () => site.work.schedule(threadId, start.commandId));
    await site.close();
    site = open();
    await phase("finished", () => site.work.recover(() => {}));
    expect(savedBinding(site.store, threadId)).toMatchObject({
      family: "pi",
      nativeSessionId,
      epoch: 2,
    });
    expect(log).toEqual(["open", "fixture input", nativeSessionId, "read original root"]);
  } finally {
    await site.close();
    host.close();
    lock.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);
