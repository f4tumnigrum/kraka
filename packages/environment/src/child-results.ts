import * as v from "valibot";
import {
  ChildResultTransferSchema,
  ObjectVersionSchema,
  type ChildResultTransfer,
  type DelegatedChildRecord,
  type MessageId,
} from "@kraka/protocol";
import { reject, type TransitionResult } from "./result";

export function prepareChildResultTransfer(
  child: DelegatedChildRecord,
): TransitionResult<ChildResultTransfer> {
  if (child.state.kind !== "completed") return reject("invalidState");
  return {
    kind: "ok",
    value: v.parse(ChildResultTransferSchema, {
      id: child.returnTransferId,
      taskId: child.taskId,
      parentThreadId: child.parentThreadId,
      parentRoundId: child.parentRoundId,
      childThreadId: child.childThreadId,
      childRoundId: child.childRoundId,
      result: child.state.result,
      version: "1",
      state: { kind: "pending" },
    }),
  };
}

/** Mark the parent return only after its message is recorded. Replays preserve the first returned message. */
export function transitionChildResultReturn(
  transfer: ChildResultTransfer,
  event: { transferId: ChildResultTransfer["id"]; parentMessageId: MessageId; returnedAt: number },
): TransitionResult<ChildResultTransfer> {
  if (event.transferId !== transfer.id) return reject("wrongDelivery");
  if (transfer.state.kind === "returned")
    return transfer.state.parentMessageId === event.parentMessageId &&
      transfer.state.returnedAt === event.returnedAt
      ? { kind: "ok", value: transfer }
      : reject("idConflict");
  if (!Number.isSafeInteger(event.returnedAt) || event.returnedAt < 0)
    return reject("invalidState");
  return {
    kind: "ok",
    value: v.parse(ChildResultTransferSchema, {
      ...transfer,
      version: v.parse(ObjectVersionSchema, (BigInt(transfer.version) + 1n).toString()),
      state: {
        kind: "returned",
        parentMessageId: event.parentMessageId,
        returnedAt: event.returnedAt,
      },
    }),
  };
}
