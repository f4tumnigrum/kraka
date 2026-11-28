import { lstat } from "node:fs/promises";
import { join } from "node:path";
import {
  readThread,
  readProject,
  registerProject,
  renameThread,
  type FirstSendStore,
  type LocalActor,
} from "@kraka/environment";
import { forgeReadOnControl } from "./signed-requests/forge";
import { openAccessHost } from "./access";
import { listenIdentity } from "./identity";
import { startWriter } from "./first-send";
import { browserAssets, preflight, type BrowserListenerOptions } from "./browser-listener";

export async function listenBrowserDaemon(stateDir: string, options: BrowserListenerOptions) {
  const binding = await preflight(options);
  const asset = await browserAssets();

  const host = await openAccessHost(stateDir);
  let closeWriter: (() => Promise<void>) | undefined;
  try {
    const port = host.port;
    const hasOwner = await lstat(join(stateDir, "local-owner.json")).then(
      (s) => s.isFile(),
      (e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return false;
      },
    );
    if (hasOwner) {
      let store: FirstSendStore | undefined;
      const writer = await startWriter(stateDir, null, {
        accessHost: host,
        opened: (s) => {
          store = s;
        },
      });
      if (writer.kind !== "ready" || !store)
        throw Error("Durable writer already owned or unavailable");
      closeWriter = writer.close;
      port.openThread = (nonce) => writer.openThread(nonce, true);
      const transaction = store;
      const access = port.request;
      port.request = (device, r) => {
        const actor: LocalActor = {
          id: device.principal.id,
          environmentId: host.identity.id,
          allows: (right, target) =>
            Boolean(host.store.ceiling(device.principal.id, target, right)),
        };
        const context = { actor, transaction, commandId: r.commandId };
        if (r.method === "forge.account" || r.method === "project.repositorySource")
          return forgeReadOnControl(r, transaction, actor);
        if (r.method === "project.register") {
          const receipt = registerProject({
            ...context,
            environmentId: actor.environmentId,
            ...r.payload,
          });
          if (receipt.kind === "accepted" && receipt.result.kind === "projectRegistered")
            host.store.provisionProject(receipt.result.project.id);
          return receipt;
        }
        if (r.method !== "thread.rename") return access(device, r);
        const thread = readThread(transaction.db, r.payload.threadId);
        if (thread) {
          const project = readProject(transaction.db, thread.projectId);
          if (project?.environmentId !== host.identity.id)
            throw Error("Thread project belongs to another environment");
          if (!host.store.ensureThread(thread.id, project.id))
            throw Error("Conflicting project for registered thread");
        }
        return renameThread({ ...context, ...r.payload });
      };
    }
    const listener = listenIdentity(port, binding.port, [], undefined, { binding, asset });
    return {
      ready: listener.ready,
      async shutdown() {
        try {
          await listener.close();
        } finally {
          try {
            await closeWriter?.();
          } finally {
            host.close();
          }
        }
      },
    };
  } catch (e) {
    try {
      await closeWriter?.();
    } finally {
      host.close();
    }
    throw e;
  }
}
