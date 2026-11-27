import { test, expect } from "bun:test";
import { join } from "node:path";
import { withState } from "../../../tools/fixtures/replay-process";
import { openBrowserFixture } from "../../../tools/fixtures/browser";
import { nativeBrowserSkipReason } from "../../../tools/fixtures/browser-selection";

const skipReason = await nativeBrowserSkipReason();
if (skipReason) console.info(skipReason);
test.skipIf(Boolean(skipReason))(
  "actual browser origin, atomic pins, route selection and per-connection configuration",
  () =>
    withState(async (dir) => {
      const f = await openBrowserFixture({
        stateDir: dir,
        profileDir: join(dir, "profile"),
        network: "loopback",
      });
      try {
        await f.pair();
        const results = await f.page.evaluate(
          async ({ origin, identity }) => {
            const path = "/assets/browser-host.js",
              m = await import(path);
            const credentials = m.createBrowserCredentials({ origin, environmentId: identity.id });
            const platform = m.createBrowserPlatform(credentials, m.browserSocketFactory);
            const confirmed = {
              origin,
              environmentId: identity.id,
              verifiedIdentity: identity,
              confirmed: true,
            };
            const same = await m.browserPins.pin(confirmed);
            const conflict = await m.browserPins.pin({
              ...confirmed,
              verifiedIdentity: { ...identity, keyVersion: 2 },
            });
            const cat = (await m.readBrowserCatalog()).catalog;
            async function open(catalog: typeof cat, pageOrigin: string, mutate: string) {
              let business = 0,
                held: string | undefined;
              const input = {
                pageOrigin,
                expectedIdentity: identity,
                routeCatalog: catalog,
                credentials,
                socketFactory: (
                  url: string,
                  receive: (e: { kind: string; data?: string }) => void,
                ) => {
                  const socket = m.browserSocketFactory(
                    url,
                    (e: { kind: string; data?: string }) => {
                      if (e.kind !== "message" || !e.data) {
                        receive(e);
                        return;
                      }
                      const frame = JSON.parse(e.data);
                      if (mutate === "early" && frame.kind === "session.authorized") {
                        held = e.data;
                        return;
                      }
                      if (frame.kind === "session.authorized") {
                        if (mutate === "principal") frame.principal.id = "other";
                        if (mutate === "owner") frame.principal.ownerId = "other";
                        if (mutate === "device") frame.principal.deviceId = "other";
                        if (mutate === "key") frame.signer.keyId = "other";
                        if (mutate === "version") frame.protocolVersion.minor++;
                        if (mutate === "features") frame.features = [];
                        if (mutate === "environment") frame.environmentId = "other";
                        if (mutate === "connection") frame.connectionId = "old";
                      }
                      if (frame.kind === "session.configuration" && mutate === "session")
                        frame.environmentSessionId = "old";
                      receive({ ...e, data: JSON.stringify(frame) });
                      if (held && frame.kind === "session.configuration") {
                        receive({ kind: "message", data: held });
                        held = undefined;
                      }
                    },
                  );
                  return {
                    ...socket,
                    send: (data: string) => {
                      if (JSON.parse(data).kind === "signedRequest") business++;
                      socket.send(data);
                    },
                  };
                },
              };
              const handle = m.openBrowserSession(input);
              const states: string[] = [];
              try {
                const snapshot = await new Promise<
                  import("../../client-runtime/src").SessionSnapshot
                >((resolve) =>
                  handle.subscribe((s: import("../../client-runtime/src").SessionSnapshot) => {
                    states.push(s.phase);
                    if (s.phase === "failed" || s.phase === "sendable" || s.phase === "unpaired")
                      resolve(s);
                  }),
                );
                if (snapshot.phase !== "sendable")
                  await handle.read({
                    commandId: "blocked",
                    method: "device.pairing.listInvites",
                    payload: { target: { kind: "project", projectId: "P" }, after: null },
                  });
                return { snapshot, business, states };
              } finally {
                handle.close();
                handle.close();
              }
            }
            const mismatch = await open(cat, "https://other.invalid", "");
            const commit = (value: unknown) =>
              platform.state.commit([
                { key: "routeCatalog", value: new TextEncoder().encode(JSON.stringify(value)) },
              ]);
            const entry = cat.environments[0],
              row = entry.routes[0];
            const off = { ...row, id: "off", endpoint: "https://other.invalid" };
            const mixed = {
              ...cat,
              environments: [{ ...entry, preferredRouteId: "off", routes: [off, row] }],
            };
            await commit(mixed);
            const changed = await open(cat, origin, "");
            const fallback = await open(mixed, origin, "early");
            const bad = [];
            for (const mutate of [
              "principal",
              "owner",
              "device",
              "key",
              "version",
              "features",
              "environment",
              "connection",
              "session",
            ])
              bad.push(await open(mixed, origin, mutate));
            const none = {
              ...mixed,
              environments: [{ ...entry, preferredRouteId: "off", routes: [off] }],
            };
            await commit(none);
            const noRoute = await open(none, origin, "");
            const invalid = [];
            for (const n of [0, 65536]) {
              await commit({
                ...cat,
                environments: [
                  { ...entry, routes: [{ ...row, endpoint: `https://kraka.test:${n}` }] },
                ],
              });
              invalid.push(await open(cat, origin, ""));
            }
            await commit(cat);
            return { same, conflict, mismatch, changed, fallback, bad, noRoute, invalid };
          },
          { origin: f.origin, identity: f.project.identity },
        );
        expect(results.same).toBe("alreadyPinned");
        expect(results.conflict).toBe("conflict");
        for (const [value, reason] of [
          [results.mismatch, "originMismatch"],
          [results.changed, "catalogChanged"],
          [results.noRoute, "noSameOriginRoute"],
          ...results.invalid.map((x) => [x, "invalidCatalog"] as const),
        ] as const)
          expect(value).toMatchObject({
            business: 0,
            snapshot: { phase: "failed", failure: { stage: "preDial", reason } },
          });
        expect(results.fallback.states).toEqual([
          "opening",
          "helloVerified",
          "authorizedAwaitingConfiguration",
          "sendable",
          "closed",
        ]);
        expect(results.fallback.snapshot).toMatchObject({
          phase: "sendable",
          routeId: `${f.project.identity.id}-browser`,
        });
        for (const value of results.bad)
          expect(value).toMatchObject({ snapshot: { phase: "failed" }, business: 0 });
        const failedPin = await f.page.evaluate(
          async ({ origin, identity }) => {
            const path = "/assets/browser-host.js",
              m = await import(path);
            const next = { ...identity, id: "distinct" };
            Reflect.get(globalThis, "abortNextBrowserWrite")("records");
            const result = await m.browserPins.pin({
              origin,
              environmentId: next.id,
              verifiedIdentity: next,
              confirmed: true,
            });
            return { result, rows: (await m.readBrowserCatalog()).catalog.environments.length };
          },
          { origin: f.origin, identity: f.project.identity },
        );
        expect(failedPin).toEqual({ result: "commitFailed", rows: 1 });
      } finally {
        await f.close();
      }
    }),
  30000,
);
