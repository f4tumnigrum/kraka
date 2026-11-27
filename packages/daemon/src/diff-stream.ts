import * as v from "valibot";
import {
  binarySource,
  ContentTransferIdSchema,
  SubscriptionIdSchema,
  TRANSPORT_LIMITS,
  type CommandReceipt,
  type FlowPeer,
  type PullFrame,
} from "@kraka/protocol";

/** A large receipt keeps its command ID while the transport assigns byte credit independently. */
export function sendGitReceipt(peer: FlowPeer, receipt: CommandReceipt, authorized: () => boolean) {
  const bytes = peer.port.utf8.encode(JSON.stringify(receipt));
  if (
    bytes.length + peer.port.utf8.encode(peer.epoch).length + 88 <=
    TRANSPORT_LIMITS.maxControlFrameBytes
  ) {
    peer.control(receipt);
    return;
  }
  const transferId = v.parse(ContentTransferIdSchema, receipt.commandId);
  let pull: PullFrame;
  const id = peer.send.open(
    v.parse(SubscriptionIdSchema, receipt.commandId),
    (offset, capacity) => {
      if (!authorized()) {
        peer.send.end(id, "authorizationRevoked");
        return null;
      }
      return pull(offset, capacity);
    },
    (frame) => {
      if ("payload" in frame && frame.message.offsetBytes + frame.payload.length === bytes.length)
        peer.send.finish(id);
    },
  );
  pull = binarySource({
    epoch: peer.epoch,
    streamId: id,
    transferId,
    length: bytes.length,
    utf8: peer.port.utf8,
    read: (off, n) => bytes.subarray(off, off + n),
  });
  peer.control({
    kind: "transport.content",
    streamId: id,
    transferId,
    encoding: "utf8Json",
    byteLength: bytes.length,
  });
}
