import type { Scenario } from "./fixture";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as v from "valibot";
import {
  CommandIdSchema,
  ExecutorInstanceIdSchema,
  HandoffContextSchema,
  PrincipalIdSchema,
} from "@kraka/protocol";
import { type FirstSendStore, readMessage, readReceipt, readRound } from "@kraka/environment";
import { attachPeer } from "../input-adapter";
export const recovery: Scenario = ({ state, recording, adapter }) => {
  let openedStore: FirstSendStore | undefined;
  const waitForClaim = attachPeer(adapter, state);
  const recover = existsSync(join(state, "dedup"));
  return {
    ...(recover
      ? {
          recovery: {
            binding: {
              family: "replay" as const,
              instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
              nativeSessionId: recording.nativeSessionId,
              epoch: 1,
            },
            input: {
              receipt: "proof" as const,
              deduplicate: "acrossRestart" as const,
              query: "none" as const,
            },
          },
        }
      : {}),
    lifecycle: {
      async beforeDispatch() {
        await waitForClaim();
        if (openedStore && existsSync(join(state, "seed-handoff"))) {
          const input = JSON.parse(readFileSync(join(state, "seed-handoff"), "utf8"));
          const round = readRound(openedStore.db, input.roundId);
          const message = round && readMessage(openedStore.db, round.messageId);
          if (!round || !message) throw Error("Missing handoff source");
          openedStore.freeze({
            attemptId: round.attempt.attemptId,
            deliveryId: round.attempt.deliveryId,
            target: {
              family: "replay",
              instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
              nativeSessionId: recording.nativeSessionId,
              epoch: 1,
            },
            messageVersion: message.version,
            input: {
              id: message.id,
              text: message.text,
              attachments: message.attachments,
              references: message.references,
            },
            parts: [],
            handoff: v.parse(HandoffContextSchema, input.handoff),
          });
          rmSync(join(state, "seed-handoff"));
        }
      },
      opened(store) {
        openedStore = store;
        store.beforeCommit = (method) => {
          const marker = join(state, "auto-row");
          if (method === "input.send" && existsSync(marker)) {
            const row = readReceipt(
              store.db,
              v.parse(PrincipalIdSchema, "first-send-local-owner"),
              v.parse(CommandIdSchema, "second"),
            );
            const result = row?.receipt.kind === "accepted" ? row.receipt.result : null;
            if (result?.kind !== "inputScheduled") throw Error("Missing automatic input fixture");
            store.db.run("UPDATE rounds SET source='automation' WHERE id=?", [result.roundId]);
            store.db.run("UPDATE messages SET data=json_set(data,'$.author',json(?)) WHERE id=?", [
              JSON.stringify({ kind: "executor", id: readFileSync(marker, "utf8") }),
              result.messageId,
            ]);
            store.db.run("INSERT INTO input_guarantees VALUES(?,?)", [
              result.deliveryId,
              JSON.stringify({
                binding: {
                  family: "replay",
                  instanceId: "replay",
                  nativeSessionId: recording.nativeSessionId,
                  epoch: 1,
                },
                input: { receipt: "proof", deduplicate: "acrossRestart", query: "none" },
              }),
            ]);
            rmSync(marker);
          }
        };
      },
      committed(req, receipt) {
        if (existsSync(join(state, "lose-" + req.commandId)) && receipt.kind === "accepted")
          return "disconnect";
      },
    },
  };
};
