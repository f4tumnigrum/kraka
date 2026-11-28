import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import * as v from "valibot";
import {
  AttemptIdSchema,
  ExecutorInstanceIdSchema,
  DeliveryIdSchema,
  MessageIdSchema,
  type CapabilitySupport,
  type CapabilityId,
  type NativeSessionId,
} from "@kraka/protocol";
import { createPiAdapter, probePi, type PiLaunch } from "../../packages/adapter-pi/src";
import { Journal } from "./route-network";
export async function buildPiPeer(dir: string) {
  const exe = resolve(dir, process.platform === "win32" ? "pi-peer.exe" : "pi-peer");
  const p = Bun.spawn(
    [
      process.execPath,
      "build",
      "--compile",
      join(import.meta.dir, "pi-rpc-peer.ts"),
      "--outfile",
      exe,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, , err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  if (code !== 0) throw Error(`Pi fixture build failed: ${err}`);
  return exe;
}
const signalSchema = v.looseObject({ event: v.string(), pid: v.number(), epoch: v.number() });
export async function piFixture(exe: string, hold?: string) {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "kraka-pi-test-")));
  const cwd = join(dir, "project"),
    accountDirectory = join(dir, "account"),
    sessionDirectory = join(dir, "sessions"),
    ledger = join(dir, "ledger");
  await Promise.all([cwd, accountDirectory, sessionDirectory].map((p) => mkdir(p)));
  const signals = new Journal<v.InferOutput<typeof signalSchema>>();
  const release = Promise.withResolvers<void>();
  const srv = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const msg = v.parse(signalSchema, await req.json());
      signals.push(msg);
      if (msg.event === hold) await release.promise;
      return new Response(null, { status: 204 });
    },
  });
  const launch: PiLaunch = {
    executable: exe,
    cwd,
    env: { KRAKA_PI_CONTROL: srv.url.href, KRAKA_PI_LEDGER: ledger },
    accountDirectory,
    sessionDirectory,
    toolPolicy: "builtin",
  };
  const permission = { selected: "ask", ceiling: "edits" } as const;
  const instance = {
    family: "pi" as const,
    instanceId: v.parse(ExecutorInstanceIdSchema, "fixture-pi"),
  };
  const probe = await probePi(launch, permission);
  const adapter = createPiAdapter(instance, launch, probe);
  const sessions = new Set<
    Extract<Awaited<ReturnType<typeof adapter.open>>, { kind: "ok" }>["value"]
  >();
  const permit = <C extends CapabilityId>(capability: C) => {
    const support: CapabilitySupport = probe.declaration.matrix[capability];
    if (support.kind === "unsupported") throw Error(`Pi did not advertise ${capability}`);
    return { ...instance, capability, capabilityVersion: probe.declaration.version, support };
  };
  const rows = async () =>
    (await readFile(ledger, "utf8"))
      .trimEnd()
      .split("\n")
      .map((s) => v.parse(signalSchema, JSON.parse(s)));
  return {
    dir,
    launch,
    permission,
    probe,
    adapter,
    permit,
    rows,
    release: () => release.resolve(),
    instance,
    async open(resume: NativeSessionId | null = null) {
      const attemptId = v.parse(AttemptIdSchema, crypto.randomUUID());
      const opened = await adapter.open({
        instance,
        attemptId,
        resume,
        setup: {
          workingDirectory: cwd,
          additionalDirectories: [],
          environment: {},
          model: { id: "sample-provider/sample-chat", options: {} },
          permission,
        },
      });
      if (opened.kind !== "ok") throw Error(JSON.stringify(opened));
      const session = opened.value;
      sessions.add(session);
      return {
        session,
        attemptId,
        events: adapter.events(session, null)[Symbol.asyncIterator](),
        async prompt(text: string, target = attemptId) {
          return adapter.invoke(session, permit("submitTextInput"), {
            kind: "deliverInput",
            capability: "submitTextInput",
            attemptId: target,
            deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
            input: {
              text,
              id: v.parse(MessageIdSchema, crypto.randomUUID()),
              attachments: [],
              references: [],
            },
          });
        },
      };
    },
    wait: (event: string, epoch: number) =>
      signals.until((s) => s.event === event && s.epoch === epoch, 0, 8000),
    async close() {
      release.resolve();
      try {
        await Promise.all(Array.from(sessions, (s) => adapter.close(s, "shutdown")));
      } finally {
        await srv.stop(true);
        await rm(dir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 });
      }
    },
  };
}
