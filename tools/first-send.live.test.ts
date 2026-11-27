import { expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import { HostInstanceIdSchema, CommandReceiptSchema } from "@kraka/protocol";
import {
  confirmWriter,
  openWriter,
  openReceiptReader,
  readThread,
  readMessage,
  readRound,
} from "@kraka/environment";
import {
  startFirstSendFixture,
  configureLocalOwner,
  launchWriter,
  accepted,
  waitFile,
  productRoot,
} from "./fixtures/first-send";
import { withState } from "./fixtures/replay-process";
import { validateNamed } from "./reference-client";
import document from "../docs/generated/protocol/protocol.schema.json";

const opts = (dir: string) => ({
  stateDir: join(dir, "state"),
  projectDirectory: join(dir, "checkout", "selected"),
  adapter: "replay" as const,
});
test("1 J-1.1 registers the selected subdirectory and resolves its host project and repository", () =>
  withState(async (dir) => {
    const options = opts(dir);
    mkdirSync(options.projectDirectory, { recursive: true });
    const checkout = join(dir, "checkout");
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "https://example.org/group/demo.git"],
    ]) {
      const result = Bun.spawnSync(["git", "-C", checkout, ...args]);
      expect(result.exitCode).toBe(0);
    }
    const f = await startFirstSendFixture(options);
    try {
      expect(f.project).toMatchObject({
        environmentId: f.instance.environmentId,
        version: "1",
        root: {
          realPath: realpathSync.native(options.projectDirectory),
          generation: "1",
          relativeToCheckout: "selected",
          repository: { host: "example.org", path: "group/demo" },
        },
      });
      const alias = join(dir, "alias");
      symlinkSync(
        options.projectDirectory,
        alias,
        process.platform === "win32" ? "junction" : "dir",
      );
      expect(
        accepted(
          (await f.client.send("project.register", { realPath: alias })).receipt,
          "projectRegistered",
        ).project,
      ).toEqual(f.project);
      const { receipt } = await f.send(),
        ids = accepted(receipt, "threadStarted");
      const db = openReceiptReader(options.stateDir);
      try {
        expect(readThread(db, ids.threadId)).toMatchObject({
          projectId: f.project.id,
          worktreeId: null,
          version: "1",
          directory: {
            kind: "projectRoot",
            directoryId: f.project.root?.directoryId,
            generation: "1",
          },
        });
      } finally {
        db.close();
      }
    } finally {
      await f.close();
    }
  }));
test(
  "2 J-1.5 a separate signed client starts the replay peer in the opened directory",
  () =>
    withState(async (dir) => {
      const options = opts(dir),
        f = await startFirstSendFixture({ ...options, point: "peer" });
      try {
        const cli = Bun.spawn(
          [process.execPath, join(productRoot, "tools/fixtures/first-send-client.ts")],
          {
            stdin: Buffer.from(
              JSON.stringify({
                stateDir: options.stateDir,
                instance: f.instance,
                method: "thread.start",
                payload: f.payload,
                id: "peer-command",
              }),
            ),
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        try {
          const [stdout, stderr, exit] = await Promise.all([
            new Response(cli.stdout).text(),
            new Response(cli.stderr).text(),
            cli.exited,
          ]);
          if (exit !== 0) throw Error(stderr);
          const { request, receipt } = JSON.parse(stdout);
          expect(validateNamed(document, "thread.start", request)).toBe(true);
          expect(validateNamed(document, "CommandReceipt", receipt)).toBe(true);
          const ids = accepted(v.parse(CommandReceiptSchema, receipt), "threadStarted");
          const file = join(options.stateDir, `started-${ids.roundId}`);
          await waitFile(file);
          const started = await Bun.file(file).json();
          expect(started).toMatchObject({
            phase: "working",
            attemptId: ids.attemptId,
            selectedMode: "ask",
            effectiveMode: "ask",
            supportedModes: ["ask"],
            enforcement: "adapter",
          });
          expect(
            await Bun.file(join(options.stateDir, `peer-${ids.deliveryId}`)).json(),
          ).toMatchObject({
            cwd: realpathSync.native(options.projectDirectory),
            attemptId: ids.attemptId,
            nativeSessionId: started.nativeSessionId,
            input: { text: f.payload.content.text },
          });
          for (const version of ["2", "3"]) {
            const id = `rename-${version}`;
            const { receipt } = await f.client.send(
              "thread.rename",
              { threadId: ids.threadId, title: `title ${version}` },
              id,
            );
            expect(accepted(receipt, "threadRenamed")).toMatchObject({
              kind: "threadRenamed",
              threadId: ids.threadId,
              version,
            });
            expect(f.receipt(id)?.receipt).toEqual(receipt);
          }
        } finally {
          if (cli.exitCode === null) cli.kill();
          await cli.exited;
        }
      } finally {
        await f.close();
      }
    }),
  20000,
);
test("3 S-STATE-004 / S-WORK-006 before-commit rollback and lost committed reply", async () => {
  for (const point of ["beforeCommit", "afterCommit"] as const)
    await withState(async (dir) => {
      const options = opts(dir),
        f = await startFirstSendFixture({ ...options, point });
      const id = "business-key";
      let original: ReturnType<typeof f.receipt>;
      try {
        const lost = f.send(id).then(
          () => false,
          () => true,
        );
        await waitFile(join(options.stateDir, `entered-${point}`));
        original = f.receipt(id);
        expect(original !== null).toBe(point === "afterCommit");
        await f.kill();
        expect(await lost).toBe(true);
      } finally {
        await f.close();
      }
      const again = await startFirstSendFixture(options);
      try {
        expect(again.instance.environmentId).toBe(f.instance.environmentId);
        expect(again.instance.instanceId).not.toBe(f.instance.instanceId);
        const db = openReceiptReader(options.stateDir);
        try {
          const n = point === "beforeCommit" ? 0 : 1;
          for (const table of ["threads", "messages", "rounds", "deliveries"])
            expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n });
          const retry = await again.client.send("thread.start", f.payload, id);
          const ids = accepted(retry.receipt, "threadStarted");
          const stored = again.receipt(id);
          expect(stored?.receipt).toEqual(retry.receipt);
          if (original) expect(stored).toEqual(original);
          expect((await again.send(id)).receipt).toEqual(retry.receipt);
          for (const table of ["threads", "messages", "rounds", "deliveries"])
            expect(db.query(`SELECT count(*) n FROM ${table}`).get()).toEqual({ n: 1 });
          expect(db.query("SELECT count(*) n FROM receipts WHERE command=?").get(id)).toEqual({
            n: 1,
          });
          expect(readMessage(db, ids.messageId)).toMatchObject({
            threadId: ids.threadId,
            roundId: ids.roundId,
            text: f.payload.content.text,
          });
          expect(readRound(db, ids.roundId)).toMatchObject({
            threadId: ids.threadId,
            messageId: ids.messageId,
            attempt: { attemptId: ids.attemptId, deliveryId: ids.deliveryId },
          });
          const thread = readThread(db, ids.threadId);
          expect(thread?.directory?.directoryId).toBe(again.project.root?.directoryId);
        } finally {
          db.close();
        }
      } finally {
        await again.close();
      }
    });
}, 30000);
test("4 competing launchers follow the lock holder and an ambiguous write stays uncertain", async () => {
  await withState(async (dir) => {
    const { stateDir } = opts(dir);
    await configureLocalOwner(stateDir);
    const holder = launchWriter(stateDir, productRoot, "locked");
    try {
      await waitFile(join(stateDir, "entered-locked"));
      const contender = launchWriter(stateDir, productRoot);
      try {
        expect(
          await openWriter(
            stateDir,
            v.parse(HostInstanceIdSchema, crypto.randomUUID()),
            performance.now() + 150,
          ),
        ).toMatchObject({ kind: "unconfirmed" });
        expect(
          await confirmWriter(realpathSync.native(stateDir), performance.now() + 100),
        ).toBeNull();
        expect(existsSync(join(stateDir, "environment.sqlite"))).toBe(false);
        writeFileSync(join(stateDir, "release-locked"), "continue");
        const incumbent = await holder.ready();
        expect(incumbent.kind).toBe("ready");
        expect(await contender.ready()).toEqual({
          kind: "existingInstance",
          publication: incumbent.publication,
        });
        const after = launchWriter(stateDir, productRoot);
        try {
          expect(await after.ready()).toEqual({
            kind: "existingInstance",
            publication: incumbent.publication,
          });
        } finally {
          await after.stop();
        }
      } finally {
        await contender.stop();
      }
    } finally {
      await holder.stop();
    }
  });
  await withState(async (dir) => {
    const options = opts(dir),
      f = await startFirstSendFixture({ ...options, point: "externalWrite" });
    let ids: ReturnType<typeof accepted<"threadStarted">>;
    try {
      ids = accepted((await f.send("ambiguous")).receipt, "threadStarted");
      await waitFile(join(options.stateDir, "entered-externalWrite"));
      expect(existsSync(join(options.stateDir, `peer-${ids.deliveryId}`))).toBe(true);
      await f.kill();
    } finally {
      await f.close();
    }
    const next = await startFirstSendFixture(options);
    try {
      expect(accepted((await next.send("ambiguous")).receipt, "threadStarted")).toEqual(ids);
      const db = openReceiptReader(options.stateDir);
      try {
        expect(readRound(db, ids.roundId)?.attempt).toEqual({
          attemptId: ids.attemptId,
          deliveryId: ids.deliveryId,
          phase: { kind: "uncertain", next: "inspectInput" },
        });
      } finally {
        db.close();
      }
    } finally {
      await next.close();
    }
  });
}, 30000);
