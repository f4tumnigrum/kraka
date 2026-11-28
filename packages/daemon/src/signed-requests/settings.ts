import {
  canonicalJson,
  sendLogicalControl,
  settingReceiptForVersion,
  type CommandReceipt,
} from "@kraka/protocol";
import {
  readProject,
  settingCommand,
  watchSettingFile,
  type FirstSendStore,
  type LocalActor,
} from "@kraka/environment";
import type { Handler } from "./context";
export function watchSettings(store: FirstSendStore) {
  let watching: string | null = null,
    stopWatching: (() => void) | undefined;
  return {
    close: () => stopWatching?.(),
    update(receipt: CommandReceipt) {
      if (
        receipt.kind === "accepted" &&
        (receipt.result.kind === "settingRead" || receipt.result.kind === "settingSaved")
      ) {
        const rb = receipt.result.readback,
          context = rb.checkout ?? rb.target;
        const key = context.kind === "checkout" ? canonicalJson(context) : null;
        if (key !== watching) {
          stopWatching?.();
          watching = key;
          stopWatching = context.kind === "checkout" ? watchSettingFile(store, context) : undefined;
        }
      }
    },
  };
}
export const settings: Handler<"settings.read" | "settings.write"> = (
  m,
  { principal, store, host, watch, settingReply, peer },
) => {
  const local: LocalActor = {
    id: principal.id,
    environmentId: host.identity.id,
    allows(permission, target) {
      if (target.kind === "project") {
        if (!readProject(store.db, target.projectId)) return false;
        host.store.provisionProject(target.projectId);
      }
      return !!host.store.ceiling(principal.id, target, permission);
    },
  };
  const execute = () =>
    settingCommand(
      { actor: local, transaction: store, commandId: m.commandId },
      m.method,
      m.payload,
    );
  const receipt = settingReply ? settingReply(m, execute) : execute();
  watch.update(receipt);
  sendLogicalControl(peer, settingReceiptForVersion(receipt, m.protocolVersion.minor));
};
