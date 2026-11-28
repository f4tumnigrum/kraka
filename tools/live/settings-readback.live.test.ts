// Live cases 4; required groups ["S18.1", "S18.2", "S18.3", "S18.4"]
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  SettingReadbackSchema,
  CommandReceiptSchema,
  DeviceSettingWriteSchema,
  ObjectVersionSchema,
  RemoteSettingTargetSchema,
  SettingCheckoutSchema,
  SettingReadSchema,
  type RemoteSettingTarget,
  type DeviceId,
  type SettingRead,
  type CommandId,
} from "@kraka/protocol";
import {
  SettingsRuntime,
  deviceSettingsStore,
  readDeviceSetting,
  type SettingsPeer,
} from "../../packages/client-runtime/src";
import { sendFirstTask } from "../../packages/cli-client/src/first-send";
import { SqliteSettingsStorage } from "../../packages/cli-client/src/settings";
import { openReceiptReader, readReceipt } from "@kraka/environment";
import { accepted } from "../fixtures/first-send";
import { readClaim, seedGit } from "../fixtures/isolated-start";
import { commandId } from "../fixtures/paired-project";
import { withState } from "../fixtures/replay-process";
import { settingsHost, modeQuery } from "../fixtures/settings-host";
import { parseScenario } from "../fixtures/scenario";
import source from "../../fixtures/scenarios/two-environments-report-setting-support-separately.json";

const zero = v.parse(ObjectVersionSchema, "0");
async function read(peer: SettingsPeer, request: SettingRead) {
  return accepted(await peer.rpc("settings.read", request, commandId()), "settingRead").readback;
}
async function hostGroup(
  run: (
    dir: string,
    start: (
      name: string,
      devices?: Parameters<typeof settingsHost>[2],
    ) => Promise<Awaited<ReturnType<typeof settingsHost>>>,
  ) => Promise<void>,
) {
  await withState(async (dir) => {
    const hosts: Awaited<ReturnType<typeof settingsHost>>[] = [];
    const errors: unknown[] = [];
    try {
      await run(dir, async (name, devices) => {
        const h = await settingsHost(dir, name, devices);
        hosts.push(h);
        return h;
      });
    } catch (error) {
      errors.push(error);
    } finally {
      for (const h of hosts.reverse()) {
        try {
          await h.close();
        } catch (error) {
          errors.push(error);
        }
      }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, "Settings group failed");
  });
}
async function withStorage<T>(path: string, run: (s: SqliteSettingsStorage) => Promise<T>) {
  const store = new SqliteSettingsStorage(path);
  try {
    return await run(store);
  } finally {
    store.close();
  }
}
const putMode = (members: { target: RemoteSettingTarget; baseVersion?: typeof zero }[]) => ({
  members,
  field: "directoryMode" as const,
  checkoutContext: null,
  explicitChoice: { kind: "set" as const, value: "worktree" as const },
});
test(
  "S18.1 device font commits and receipts belong to one reopened device",
  () =>
    hostGroup(async (dir, start) => {
      const a = await start("font");
      const first = a.pair.owner.device.deviceId,
        second = a.pair.clients[0]!.device.deviceId;
      const path = (id: DeviceId) => join(dir, id + ".sqlite");
      const row = (id: DeviceId) =>
        withStorage(path(id), (db) => deviceSettingsStore(db, id).read("fontSize"));
      for (const id of [first, second])
        expect(readDeviceSetting(await row(id))).toMatchObject({
          value: 16,
          source: { kind: "builtin" },
          version: "0",
        });
      const cmd = commandId(),
        edit = v.parse(DeviceSettingWriteSchema, {
          field: "fontSize",
          target: { kind: "device", deviceId: first },
          baseVersion: "0",
          change: { kind: "set", value: 22 },
        });
      const save = () =>
        withStorage(path(first), (db) => deviceSettingsStore(db, first).write(cmd, edit));
      expect((await save()).kind).toBe("saved");
      const reopened = await row(first);
      expect(reopened).toMatchObject({ explicit: { kind: "set", value: 22 }, version: "1" });
      expect(readDeviceSetting(reopened)).toMatchObject({ value: 22, source: edit.target });
      expect((await save()).row).toEqual(reopened);
      expect(await row(second)).toMatchObject({ explicit: { kind: "absent" }, version: "0" });
      expect((await read(a.owner, modeQuery(a.target))).effective.value).toBe("local");
      expect((await read(a.reader, modeQuery(a.target))).effective.value).toBe("local");
    }),
  45_000,
);

test(
  "S18.2 reset reveals only the verified checkout declaration and generation",
  () =>
    hostGroup(async (dir, start) => {
      const a = await start("reset");
      const b = seedGit(dir, "sibling");
      const second = accepted(
        (await a.writer.client.send("project.register", { realPath: b.path })).receipt,
        "projectRegistered",
      ).project;
      const contexts = [];
      for (const project of [a.writer.project, second]) {
        const target = v.parse(RemoteSettingTargetSchema, {
          ...a.target,
          kind: "project",
          projectId: project.id,
        });
        const { id } = await a.startCheckout(project.id);
        const checkout = v.parse(SettingCheckoutSchema, {
          ...target,
          kind: "checkout",
          worktreeId: id,
        });
        const claim = readClaim(a.state, id);
        contexts.push({
          req: modeQuery(target, checkout),
          path: claim.directory.realPath,
          generation: claim.directory.binding.generation,
        });
      }
      const [left, right] = contexts;
      if (!left || !right) throw Error("Missing real checkouts");
      for (const c of [left, right])
        expect(await read(a.owner, c.req)).toMatchObject({
          atLayer: { kind: "absent" },
          effective: { value: "local", source: { kind: "builtin" } },
        });
      writeFileSync(join(left.path, "kraka.json"), JSON.stringify({ directoryMode: "worktree" }));
      const save = await a.owner.rpc(
        "settings.write",
        { ...left.req, baseVersion: zero, change: { kind: "set", value: "local" } },
        commandId(),
      );
      expect(accepted(save, "settingSaved").readback.effective.source.kind).toBe("project");
      expect((await read(a.reader, right.req)).effective.source.kind).toBe("builtin");
      await a.owner.rpc(
        "settings.write",
        { ...left.req, baseVersion: v.parse(ObjectVersionSchema, "1"), change: { kind: "absent" } },
        commandId(),
      );
      const rb = await read(a.reader, left.req);
      expect(rb).toMatchObject({
        atLayer: { kind: "absent" },
        fieldVersion: "2",
        effective: {
          value: "worktree",
          source: { kind: "repository", generation: left.generation, path: "kraka.json" },
          sourceVersion: "1",
        },
      });
      expect((await read(a.owner, modeQuery(left.req.target))).effective.source.kind).toBe(
        "builtin",
      );
      const task = await sendFirstTask(
        a.writer.client,
        join(dir, "new-task.sqlite"),
        "inherited",
        a.target.environmentId,
        "fixture",
        {
          projectId: a.writer.project.id,
          checkout: { kind: "inherit", context: left.req.checkout },
          content: a.writer.payload.content,
        },
      );
      const started = accepted(task.receipt, "threadStarted");
      await a.events.untilDispatch((e) => e.event === "ended" && e.roundId === started.roundId);
      const binding = v.parse(v.object({ worktreeId: v.string() }), task.request.payload);
      expect(readClaim(a.state, binding.worktreeId).claim.threadId).toBe(started.threadId);
      writeFileSync(join(left.path, "replacement"), '{"directoryMode":"local"}');
      renameSync(join(left.path, "replacement"), join(left.path, "kraka.json"));
      const reopened = await a.restart();
      expect(await read(reopened, left.req)).toMatchObject({
        fieldVersion: "2",
        effective: { value: "local", source: { kind: "repository" }, sourceVersion: "2" },
      });
      renameSync(left.path, left.path + "-original");
      mkdirSync(left.path);
      writeFileSync(join(left.path, "kraka.json"), '{"directoryMode":"worktree"}');
      expect(await reopened.rpc("settings.read", left.req, commandId())).toMatchObject({
        kind: "rejected",
        failure: { kind: "invalidState" },
      });
    }),
  90_000,
);

test(
  "S18.3 studio, archive and older peers show individual readbacks on both client views",
  () =>
    hostGroup(async (dir, start) => {
      const scenario = parseScenario(source);
      const [studio, archive] = scenario.environments;
      const event = scenario.inputs[0]?.event;
      if (!studio || !archive || event?.kind !== "commands")
        throw Error("Missing selected environments");
      const edit = event.requests[0];
      if (edit?.method !== "settings.write" || edit.payload.field !== "directoryMode")
        throw Error("Missing fixture edit");
      const a = await start(studio.environmentId),
        b = await start(archive.environmentId, a.devices),
        bare = await start("bare", a.devices);
      b.setMode("legacy");
      bare.setMode("bare");
      const offline = v.parse(RemoteSettingTargetSchema, {
        kind: "environment",
        environmentId: "disconnected",
      });
      const path = join(dir, "desktop.sqlite");
      const id = a.devices.owner.deviceId;
      const seed = v.parse(SettingReadSchema, { ...modeQuery(a.target), field: "defaultModel" });
      await a.owner.rpc(
        "settings.write",
        { ...seed, change: { kind: "set", value: null }, baseVersion: zero },
        commandId(),
      );
      await withStorage(path, async (db) => {
        const web = new SettingsRuntime(db, id, commandId);
        for (const h of [a, b, bare]) await web.authorize(h.target.environmentId, h.owner);
        const members = [a.target, b.target, offline, bare.target].map((target) => ({
          target,
          baseVersion: edit.payload.baseVersion,
        }));
        const batch = await web.submitSettings({
          ...putMode(members),
          field: edit.payload.field,
          explicitChoice: edit.payload.change,
        });
        expect(batch.map((r) => r.status)).toEqual([
          "saved",
          "unrecognized",
          "offline",
          "checking",
        ]);
        const expected = v.parse(
          CommandReceiptSchema,
          scenario.clients[0]?.expected[0]?.messages[0],
        );
        if (expected?.kind !== "accepted" || expected.result.kind !== "settingSaved")
          throw Error("Missing studio readback");
        expect(await read(a.reader, modeQuery(a.target))).toEqual(
          v.parse(SettingReadbackSchema, {
            ...expected.result.readback,
            target: a.target,
            effective: { ...expected.result.readback.effective, source: a.target },
          }),
        );
        expect(await b.reader.rpc("settings.read", modeQuery(b.target), commandId())).toMatchObject(
          {
            kind: "rejected",
            failure: { kind: "unrecognizedSetting", supportedFields: archive.legacySettingFields },
          },
        );
        expect((await read(bare.reader, modeQuery(bare.target))).effective.value).toBe("local");
        b.setMode("oldValue");
        // The worktree switch's two positions are the catalog's local/worktree values.
        const clearStudio = async () => {
          const before = await read(a.owner, modeQuery(a.target));
          return accepted(
            await a.owner.rpc(
              "settings.write",
              {
                ...modeQuery(a.target),
                baseVersion: before.fieldVersion,
                change: { kind: "absent" },
              },
              commandId(),
            ),
            "settingSaved",
          ).readback;
        };
        const submit = async (view: SettingsRuntime) => {
          const rb = await clearStudio();
          expect(rb.effective.value).toBe("local");
          return view.submitSettings(
            putMode([
              { target: a.target, baseVersion: rb.fieldVersion },
              { target: b.target, baseVersion: zero },
            ]),
          );
        };
        const both = await submit(web);
        const device = a.devices.applicants[0];
        if (!device) throw Error("Missing mobile identity");
        const mobile = await withStorage(join(dir, "mobile.sqlite"), async (store) => {
          const view = new SettingsRuntime(store, device.deviceId, commandId);
          for (const host of [a, b]) {
            const principal = host.pair.clients[0]?.principal;
            if (!principal) throw Error("Missing paired client");
            accepted(
              await host.pair.owner.request({
                method: "access.grant",
                commandId: commandId(),
                payload: {
                  target: host.target,
                  principalId: principal.id,
                  permission: "settings.change",
                  modeCeiling: "ask",
                  inheritance: "targetOnly",
                },
              }),
              "accessChanged",
            );
            await view.authorize(host.target.environmentId, host.reader);
          }
          return submit(view);
        });
        expect(mobile[0]?.commandId).not.toBe(both[0]?.commandId);
        for (const view of [both, mobile]) {
          expect(view.filter((r) => r.status === "saved")).toHaveLength(1);
          expect(view[0]).toMatchObject({
            environmentId: a.target.environmentId,
            status: "saved",
            visible: { effective: { value: "worktree" } },
          });
          expect(view[1]).toMatchObject({
            environmentId: b.target.environmentId,
            status: "unrecognized",
            upgrade: true,
            visible: { effective: { value: "local" } },
          });
        }
        expect((await read(b.reader, modeQuery(b.target))).effective.value).toBe("local");
        for (const [h, row] of [
          [a, both[0]],
          [b, both[1]],
          [bare, batch[3]],
        ] as const)
          expect(
            (await h.events.until((e) => e.event === "setting" && e.commandId === row?.commandId))
              .event,
          ).toBe("setting");
      });
    }),
  90_000,
);

test(
  "S18.4 reconnect reuses the first receipt after commit and preserves the other outcomes",
  () =>
    hostGroup(async (dir, start) => {
      const a = await start("loss"),
        b = await start("lock", a.devices);
      a.setMode("drop");
      b.setMode("locked");
      const offline = v.parse(RemoteSettingTargetSchema, {
        kind: "environment",
        environmentId: "offline",
      });
      const id = a.devices.owner.deviceId,
        path = join(dir, "pending.sqlite");
      const ids = await withStorage(path, async (db) => {
        const runtime = new SettingsRuntime(db, id, commandId);
        await runtime.authorize(a.target.environmentId, a.owner);
        await runtime.authorize(b.target.environmentId, b.owner);
        const batch = await runtime.submitSettings(
          putMode([a.target, b.target, offline].map((target) => ({ target }))),
        );
        expect(batch.map((x) => x.status)).toEqual(["checking", "locked", "offline"]);
        expect(batch[1]?.member).toMatchObject({
          outcome: { lockedBy: { environmentId: b.target.environmentId, policyId: "ops" } },
        });
        return batch.map((r) => r.commandId);
      });
      const key = ids[0];
      if (!key) throw Error("No original command");
      function first(k: CommandId) {
        const db = openReceiptReader(a.state);
        try {
          return readReceipt(db, a.pair.owner.principal.id, k);
        } finally {
          db.close();
        }
      }
      const original = first(key);
      expect(original?.receipt).toMatchObject({
        result: { readback: { fieldVersion: "1", readVersion: "1" } },
      });
      a.setMode("current");
      const writer = await a.restart();
      expect(await read(writer, modeQuery(a.target))).toMatchObject({
        atLayer: { kind: "set", value: "worktree" },
        fieldVersion: "1",
        effective: { source: a.target },
      });
      const revert = await writer.rpc(
        "settings.write",
        {
          ...modeQuery(a.target),
          baseVersion: v.parse(ObjectVersionSchema, "1"),
          change: { kind: "absent" },
        },
        commandId(),
      );
      expect(accepted(revert, "settingSaved").readback.readVersion).toBe(
        v.parse(ObjectVersionSchema, "2"),
      );
      await withStorage(path, async (db) => {
        const r = new SettingsRuntime(db, id, commandId);
        // A newer authoritative view arrives before the historical receipt.
        const peer: SettingsPeer = {
          rpc: async (method, payload, cmd) => {
            if (method === "settings.write") await r.read(modeQuery(a.target));
            return writer.rpc(method, payload, cmd);
          },
        };
        await r.authorize(a.target.environmentId, peer);
        await r.authorize(a.target.environmentId, peer);
        const batch = await r.batch(ids);
        expect(batch.map((x) => x.status)).toEqual(["saved", "locked", "offline"]);
        expect(batch[0]).toMatchObject({
          visible: { atLayer: { kind: "absent" }, fieldVersion: "2" },
          member: { outcome: { readback: { readVersion: "1" } } },
        });
        expect(first(key)).toEqual(original);
        expect((await read(writer, modeQuery(a.target))).fieldVersion).toBe(
          v.parse(ObjectVersionSchema, "2"),
        );
        expect((await read(b.reader, modeQuery(b.target))).fieldVersion).toBe(zero);
        expect(
          a.events.items.filter((x) => x.event === "setting" && x.commandId === key),
        ).toHaveLength(2);
      });
    }),
  90_000,
);
