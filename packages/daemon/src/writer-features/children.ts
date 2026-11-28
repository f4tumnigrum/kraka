import type { WriterFeature } from "./types";

export const children = {
  register({ store }) {
    const children = store.services.childTransfers;
    for (const id of children.pending()) {
      store.recovery.register("child-return:" + id, async () => {
        await children.beforeRecovery?.();
        await children.returnToParent(id);
      });
    }
  },
} satisfies WriterFeature;
