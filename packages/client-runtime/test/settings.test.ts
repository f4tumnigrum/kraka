import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  CommandIdSchema,
  readSettingWritePayload,
  TransportFrameHeaderSchema,
  DeviceSettingRowSchema,
  SettingWriteSchema,
  SignedRequestSchema,
  REQUEST_METHODS,
} from "@kraka/protocol";
import {
  advanceSettingWrite,
  prepareSettingWrites,
  readDeviceSetting,
  type SettingWriteMember,
} from "../src";

function write(environmentId: string) {
  const target = { kind: "environment", environmentId };
  return {
    commandId: v.parse(CommandIdSchema, `write-${environmentId}`),
    edit: v.parse(SettingWriteSchema, {
      field: "directoryMode",
      target,
      checkout: null,
      change: { kind: "set", value: "worktree" },
      baseVersion: "0",
    }),
  };
}
function reply(member: SettingWriteMember, result: unknown) {
  return advanceSettingWrite(member, {
    kind: "reply",
    environmentId: member.edit.target.environmentId,
    receipt: { kind: "accepted", commandId: member.commandId, result },
  });
}
test("classifies four independently selected environments, including the one offline before send", () => {
  const writes = ["one", "two", "three", "four"].map(write);
  const batch = prepareSettingWrites(writes);
  const outcomes = [];
  for (const [env, members] of batch) {
    const member = members[0];
    if (!member) throw new Error("Missing batch member");
    const checking = advanceSettingWrite(member, { kind: "sending" });
    let next: SettingWriteMember;
    switch (String(env)) {
      case "one":
        next = reply(checking, {
          kind: "settingSaved",
          supportedFields: ["directoryMode"],
          readback: {
            field: "directoryMode",
            target: member.edit.target,
            checkout: null,
            atLayer: member.edit.change,
            fieldVersion: "2",
            readVersion: "9",
            effective: { value: "worktree", source: member.edit.target, sourceVersion: "2" },
          },
        });
        break;
      case "two":
        next = advanceSettingWrite(checking, {
          kind: "reply",
          environmentId: env,
          receipt: {
            kind: "rejected",
            commandId: member.commandId,
            failure: {
              kind: "settingLocked",
              supportedFields: ["directoryMode"],
              request: { field: "directoryMode", target: member.edit.target, checkout: null },
              lockedBy: { kind: "lock", environmentId: env, policyId: "ops" },
            },
          },
        });
        break;
      case "three":
        next = reply(checking, { kind: "actionAccepted", supportedFields: ["defaultModel"] });
        break;
      default:
        next = advanceSettingWrite(member, { kind: "offlineBeforeSend" });
    }
    expect(next.kind).toBe("finished");
    if (next.kind === "finished") outcomes.push(next.outcome.kind);
    expect(advanceSettingWrite(next, { kind: "sending" })).toBe(next);
  }
  expect(outcomes).toEqual(["saved", "locked", "unrecognized", "offline"]);
});

test("keeps an interrupted send, bare success, mismatched receipt or masked write pending", () => {
  const member = advanceSettingWrite({ kind: "prepared", ...write("one") }, { kind: "sending" });
  expect(advanceSettingWrite(member, { kind: "offlineBeforeSend" })).toBe(member);
  expect(reply(member, { kind: "actionAccepted" })).toBe(member);
  expect(reply(member, { kind: "actionAccepted", supportedFields: ["directoryMode"] })).toBe(
    member,
  );
  const receipt = {
    kind: "accepted",
    commandId: member.commandId,
    result: { kind: "actionAccepted", supportedFields: [] },
  };
  const other = write("other");
  expect(
    advanceSettingWrite(member, {
      kind: "reply",
      environmentId: other.edit.target.environmentId,
      receipt,
    }),
  ).toBe(member);
  expect(
    advanceSettingWrite(member, {
      kind: "reply",
      environmentId: member.edit.target.environmentId,
      receipt: { ...receipt, commandId: other.commandId },
    }),
  ).toBe(member);
  const readback = {
    field: "directoryMode",
    target: member.edit.target,
    checkout: null,
    atLayer: { kind: "absent" },
    fieldVersion: "0",
    readVersion: "4",
    effective: {
      value: "worktree",
      source: { kind: "organizationDefault", environmentId: "one", policyId: "group" },
      sourceVersion: "4",
    },
  };
  expect(
    reply(member, { kind: "settingSaved", supportedFields: ["directoryMode"], readback }),
  ).toBe(member);
});

test("keeps device font size on the device even when its explicit value matches the default", () => {
  const row = { field: "fontSize", target: { kind: "device", deviceId: "dev" }, version: "1" };
  expect(
    readDeviceSetting(v.parse(DeviceSettingRowSchema, { ...row, explicit: { kind: "absent" } })),
  ).toMatchObject({ value: 16, source: { kind: "builtin" } });
  expect(
    readDeviceSetting(
      v.parse(DeviceSettingRowSchema, { ...row, explicit: { kind: "set", value: 16 } }),
    ),
  ).toMatchObject({ value: 16, source: row.target });
  expect(
    v.safeParse(SettingWriteSchema, {
      field: "fontSize",
      target: { kind: "environment", environmentId: "env" },
      checkout: null,
      baseVersion: "0",
      change: { kind: "set", value: 16 },
    }).success,
  ).toBe(false);
  expect(REQUEST_METHODS.writeSetting.permission).toBe("settings.change");
  expect(
    v.safeParse(SignedRequestSchema, {
      kind: "signedRequest",
      method: "settings.write",
      payload: row,
    }).success,
  ).toBe(false);
});

test("reads supported-field evidence through a normal control frame and distinguishes malformed values from future fields", () => {
  const { edit, commandId } = write("env");
  const wire = {
    kind: "signedRequest",
    protocolVersion: { major: 1, minor: 0 },
    environmentId: "env",
    connectionId: "c",
    challengeId: "challenge",
    challenge: "A".repeat(43),
    signer: { kind: "device", deviceId: "d", keyId: "k" },
    sequence: 1,
    commandId,
    method: "settings.write",
    payload: edit,
    signature: "A".repeat(86),
  };
  expect(v.parse(SignedRequestSchema, wire).method).toBe("settings.write");
  expect(
    v.safeParse(SignedRequestSchema, {
      ...wire,
      payload: { ...edit, change: { kind: "set", value: "invalid mode" } },
    }).success,
  ).toBe(false);
  expect(
    readSettingWritePayload(commandId, { ...edit, change: { kind: "set", value: "invalid mode" } })
      .kind,
  ).toBe("invalid");
  const future = readSettingWritePayload(commandId, { ...edit, field: "futureSetting" });
  expect(future).toMatchObject({
    kind: "unrecognized",
    receipt: {
      kind: "rejected",
      failure: {
        kind: "unrecognizedSetting",
        supportedFields: expect.arrayContaining(["directoryMode", "defaultModel"]),
      },
    },
  });
  const checking = advanceSettingWrite({ kind: "prepared", edit, commandId }, { kind: "sending" });
  const receipt = {
    kind: "accepted",
    commandId,
    result: { kind: "actionAccepted", supportedFields: ["defaultModel"] },
  };
  const frame = v.parse(TransportFrameHeaderSchema, {
    lane: "control",
    epoch: "c",
    streamId: 0,
    offsetBytes: 0,
    message: receipt,
  });
  if (frame.lane !== "control") throw new Error("Expected a control frame");
  expect(
    advanceSettingWrite(checking, {
      kind: "reply",
      environmentId: edit.target.environmentId,
      receipt: frame.message,
    }),
  ).toMatchObject({ kind: "finished", outcome: { kind: "unrecognized" } });
});

test("a separately decoded custom worktree path completes its original write", () => {
  const target = { kind: "environment", environmentId: "studio" };
  const change = { kind: "set", value: { kind: "custom", path: "/worktrees" } };
  const member = advanceSettingWrite(
    {
      kind: "prepared",
      commandId: v.parse(CommandIdSchema, "write-location"),
      edit: v.parse(SettingWriteSchema, {
        field: "worktreeLocation",
        target,
        checkout: null,
        baseVersion: "0",
        change,
      }),
    },
    { kind: "sending" },
  );
  const result = {
    kind: "settingSaved",
    supportedFields: ["worktreeLocation"],
    readback: {
      field: "worktreeLocation",
      target,
      checkout: null,
      atLayer: change,
      fieldVersion: "1",
      readVersion: "1",
      effective: { value: change.value, source: target, sourceVersion: "1" },
    },
  };
  expect(reply(member, JSON.parse(JSON.stringify(result)))).toMatchObject({
    kind: "finished",
    outcome: { kind: "saved" },
  });
  expect(
    reply(member, {
      ...result,
      readback: {
        ...result.readback,
        atLayer: { kind: "set", value: { kind: "custom", path: "/different" } },
      },
    }),
  ).toBe(member);
});

test("a returned input leaves a durable setting checking until its own readback arrives", async () => {
  const { SettingsRuntime } = await import("../src/setting-batch");
  const { DeviceIdSchema, SettingReadbackSchema, CommandReceiptSchema } = await import(
    "@kraka/protocol"
  );
  const { edit } = write("one");
  const env = edit.target.environmentId;
  const device = v.parse(DeviceIdSchema, "desktop");
  const initial = v.parse(SettingReadbackSchema, {
    field: edit.field,
    target: edit.target,
    checkout: null,
    atLayer: { kind: "absent" },
    fieldVersion: "0",
    readVersion: "0",
    effective: { value: "local", source: { kind: "builtin" }, sourceVersion: null },
  });
  let raw: unknown = null;
  const runtime = new SettingsRuntime(
    {
      async update(key, edit) {
        expect(key).toContain(device);
        const next = edit(raw);
        raw = next.value;
        return next.result;
      },
    },
    device,
    () => v.parse(CommandIdSchema, crypto.randomUUID()),
  );
  let receive: ((r: import("@kraka/protocol").CommandReceipt) => Promise<void>) | undefined;
  let sends = 0;
  await runtime.authorize(env, {
    onSettingReceipt(f) {
      receive = f;
      return () => {
        receive = undefined;
      };
    },
    async rpc(method, _payload, commandId) {
      if (method === "settings.read")
        return { kind: "accepted", commandId, result: { kind: "settingRead", readback: initial } };
      sends++;
      return { kind: "accepted", commandId, result: { kind: "actionAccepted" } };
    },
  });
  const [member] = await runtime.submitSettings({
    members: [{ target: edit.target }],
    field: edit.field,
    explicitChoice: edit.change,
    checkoutContext: null,
  });
  if (!member || !receive) throw Error("Missing pending write");
  const { commandId } = member;
  const result = {
    kind: "textReturned",
    transferId: "t1",
    source: { environmentId: env, threadId: "source", roundId: "old" },
    target: { environmentId: env, threadId: "target" },
    text: "saved input",
    history: { coverage: "complete", omittedItems: 0, missingSources: [] },
    input: { messageId: "m", roundId: "r", attemptId: "a", deliveryId: "d" },
  };
  await receive(v.parse(CommandReceiptSchema, { kind: "accepted", commandId, result }));
  expect((await runtime.batch([commandId]))[0]).toMatchObject({
    status: "checking",
    visible: initial,
  });
  const saved = v.parse(CommandReceiptSchema, {
    kind: "accepted",
    commandId,
    result: {
      kind: "settingSaved",
      supportedFields: [edit.field],
      readback: {
        ...initial,
        atLayer: edit.change,
        fieldVersion: "1",
        readVersion: "1",
        effective: { value: "worktree", source: edit.target, sourceVersion: "1" },
      },
    },
  });
  await receive(saved);
  expect((await runtime.batch([commandId]))[0]).toMatchObject({
    status: "saved",
    visible: { atLayer: edit.change, effective: { source: edit.target, value: "worktree" } },
  });
  expect(sends).toBe(1);
});
