import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandIdSchema,
  PrincipalIdSchema,
  SettingReadSchema,
  SettingWriteSchema,
  type CommandReceipt,
} from "@kraka/protocol";
import { settingCommand, type FirstSendStore } from "@kraka/environment";
import type { FixtureSettingReply } from "../../packages/daemon/src/thread-connection";

export function settingPeer(state: string, getStore: () => FirstSendStore): FixtureSettingReply {
  return (req, execute) => {
    const mode = v.parse(
      v.picklist(["current", "legacy", "oldValue", "bare", "locked", "drop"]),
      JSON.parse(readFileSync(join(state, "setting-peer.json"), "utf8")),
    );
    const { commandId } = req;
    let receipt: CommandReceipt;
    if (
      req.method === "settings.read" &&
      mode === "legacy" &&
      req.payload.field === "directoryMode"
    ) {
      receipt = {
        kind: "rejected",
        commandId,
        failure: { kind: "unrecognizedSetting", ...req.payload, supportedFields: ["defaultModel"] },
      };
    } else if (req.method === "settings.read" || mode === "current" || mode === "drop") {
      receipt = execute();
    } else {
      const { field, target, checkout } = v.parse(SettingWriteSchema, req.payload);
      const request = v.parse(SettingReadSchema, { field, target, checkout });
      if (mode === "locked")
        receipt = {
          kind: "rejected",
          commandId,
          failure: {
            kind: "settingLocked",
            request,
            supportedFields: [field],
            lockedBy: { kind: "lock", environmentId: req.environmentId, policyId: "ops" },
          },
        };
      else if (mode === "oldValue") {
        // The peer reports its own unchanged state after ignoring this edit.
        const readback = settingCommand(
          {
            transaction: getStore(),
            actor: {
              environmentId: req.environmentId,
              id: v.parse(PrincipalIdSchema, "compatibility-read"),
              allows: () => true,
            },
            commandId: v.parse(CommandIdSchema, crypto.randomUUID()),
          },
          "settings.read",
          request,
        );
        if (readback.kind !== "accepted" || readback.result.kind !== "settingRead")
          throw Error("Missing old setting");
        receipt = {
          kind: "accepted",
          commandId,
          result: {
            kind: "settingSaved",
            supportedFields: ["defaultModel"],
            readback: readback.result.readback,
          },
        };
      } else
        receipt = {
          kind: "accepted",
          commandId,
          result:
            mode === "legacy"
              ? { kind: "actionAccepted", supportedFields: ["defaultModel"] }
              : { kind: "actionAccepted" },
        };
    }
    process.send?.({
      event: "setting",
      environmentId: req.environmentId,
      commandId,
      method: req.method,
      receipt,
    });
    if (mode === "drop" && req.method === "settings.write" && receipt.kind === "accepted")
      throw Error("Fixture dropped committed reply");
    return receipt;
  };
}
