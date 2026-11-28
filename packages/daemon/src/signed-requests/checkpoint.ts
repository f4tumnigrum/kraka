import type { Handler, RequestContext } from "./context";
import { resolveDiffDirectory } from "@kraka/environment";
import {
  sendLogicalRequest,
  DiffResultSchema,
  type SignedRequest,
  type CommandReceipt,
} from "@kraka/protocol";
import * as v from "valibot";
async function readDiff(
  { store, allows, session, visibility, diffService }: RequestContext,
  request: Extract<SignedRequest, { method: "checkpoint.diff" }>,
): Promise<CommandReceipt> {
  const { commandId } = request;
  const { query, cursor } = request.payload;
  const unavailable = (reason: string) =>
    v.parse(DiffResultSchema, {
      kind: "unavailable",
      request: query,
      from: null,
      to: null,
      reason,
    });
  if (!allows(query.threadId, "thread.view"))
    return { kind: "rejected", commandId, failure: { kind: "notFound" } };
  const directoryDiff = session.features.includes("directoryDiff");
  if ("directoryId" in query && !directoryDiff)
    return {
      kind: "rejected",
      commandId,
      failure: { kind: "unsupported" },
    };
  const directory = resolveDiffDirectory(store, query);
  const actor = { scope: visibility(), directoryDiff };
  const diff = !directory
    ? unavailable("invalidated")
    : query.kind === "round" || query.kind === "roundRange"
      ? await store.captures.readCaptureRange({
          thread: query.threadId,
          worktree: directory,
          fromCaptureId: query.kind === "round" ? query.captureId : query.fromCaptureId,
          toCaptureId: query.kind === "round" ? query.captureId : query.toCaptureId,
          single: query.kind === "round",
          cursor,
          actor,
          reader: diffService,
        })
      : await diffService.readLocalDiff({
          actor,
          query,
          cursor,
          resolvedDirectory: directory,
        });
  return { kind: "accepted", commandId, result: { kind: "checkpointDiff", diff } };
}
export const checkpoint: Handler<"checkpoint.diff"> = (m, context) => {
  const { store, visibility, allows, active, peer, disclose, wake, failed } = context;
  const scope = visibility();
  const allowed = () => scope === visibility() && allows(m.payload.query.threadId, "thread.view");
  const work = readDiff(context, m)
    .then((receipt) => {
      if (!active()) return;
      if (receipt.kind === "accepted" && !allowed())
        peer.control({
          kind: "rejected",
          commandId: m.commandId,
          failure: { kind: "notFound" },
        });
      else if (receipt.kind === "accepted") disclose(receipt, allowed);
      else sendLogicalRequest(peer, receipt);
      wake();
    })
    .catch(() => failed(m.commandId));
  store.diffReads.add(work);
  void work.finally(() => store.diffReads.delete(work));
};
