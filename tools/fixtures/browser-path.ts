import type { Page } from "playwright";
import type { EnvironmentIdentity, ProjectId } from "@kraka/protocol";
export async function samplePath(
  page: Page,
  identity: EnvironmentIdentity,
  origin: string,
  projectId: ProjectId,
  seed: string,
) {
  return page.evaluate(
    async ({ identity, origin, projectId, seed }) => {
      const path = "/assets/browser-host.js",
        m = await import(path);
      m.pageSession?.close();
      const input = {
        pageOrigin: origin,
        expectedIdentity: identity,
        routeCatalog: (await m.readBrowserCatalog()).catalog,
        credentials: m.createBrowserCredentials({ origin, environmentId: identity.id }),
        socketFactory: m.browserSocketFactory,
      };
      const rows = [];
      for (let i = 0; i < 10; i++) {
        const times = { dial: 0, hello: 0, sendable: 0, submit: 0, receipt: 0 };
        const commandId = crypto.randomUUID();
        const h = m.openBrowserSession({
          ...input,
          socketFactory: (url: string, recv: Parameters<typeof m.browserSocketFactory>[1]) => {
            times.dial = performance.now();
            return input.socketFactory(url, recv);
          },
        });
        try {
          const snap = await new Promise<
            import("../../packages/client-runtime/src").SessionSnapshot
          >((resolve, reject) => {
            h.subscribe((s: import("../../packages/client-runtime/src").SessionSnapshot) => {
              if (s.phase === "helloVerified") times.hello = performance.now();
              if (s.phase === "sendable") {
                times.sendable = performance.now();
                resolve(s);
              }
              if (s.phase === "failed") reject(Error(JSON.stringify(s)));
            });
          });
          times.submit = performance.now();
          const r = await h.read({
            commandId,
            method: "device.pairing.listInvites",
            payload: { target: { kind: "project", projectId }, after: null },
          });
          times.receipt = performance.now();
          if (
            snap.phase !== "sendable" ||
            snap.identity.id !== identity.id ||
            r.kind !== "receipt" ||
            r.receipt.commandId !== commandId ||
            r.receipt.kind !== "accepted" ||
            r.receipt.result.kind !== "invitesListed" ||
            !r.receipt.result.invites.some((i: { inviteId: string }) => i.inviteId === seed)
          )
            throw Error("Path read did not match seeded invite");
          rows.push({
            times,
            commandId,
            connectionId: snap.connectionId,
            device: snap.authorization.principal,
            environmentId: snap.identity.id,
            projectId,
          });
        } finally {
          h.close();
        }
      }
      return rows;
    },
    { identity, origin, projectId, seed },
  );
}
