import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  BUSINESS_CLOSE_CODES,
  BUSINESS_WEBSOCKET_PATH,
  ROUTE_LIMITS,
  RouteDiagnosticSchema,
  migrateRouteCatalog,
} from "./index";

const first = {
  id: "first",
  environmentId: "environment",
  kind: "lan",
  endpoint: "https://environment.local",
  lastObservedSecureContext: true,
  status: { kind: "reachable", checkedAt: 10 },
};
const second = { ...first, id: "second", kind: "ssh", endpoint: "http://127.0.0.1:49152" };
const catalog = {
  formatVersion: 1,
  environments: [
    {
      environmentId: "environment",
      pinnedIdentity: { id: "environment", publicKey: "A".repeat(87), keyVersion: 1 },
      preferredRouteId: "second",
      routes: [first, { ...second, sshProfileReference: "ssh-profile" }],
    },
  ],
};

test("loading a current route catalog preserves trust and manual order and reprobes every route", () => {
  const loaded = migrateRouteCatalog(catalog);
  expect<unknown>(loaded).toEqual({
    kind: "ready",
    catalog: {
      ...catalog,
      environments: [
        {
          ...catalog.environments[0],
          routes: [
            { ...first, status: { kind: "untested" } },
            { ...second, sshProfileReference: "ssh-profile", status: { kind: "untested" } },
          ],
        },
      ],
    },
  });
  expect(catalog.environments[0]?.routes[0]?.status.kind).toBe("reachable");
  if (loaded.kind === "ready") expect(migrateRouteCatalog(loaded.catalog)).toEqual(loaded);
});

test("legacy route rows migrate without inferring a pinned identity from reachability", () => {
  const loaded = migrateRouteCatalog([first, second]);
  expect<unknown>(loaded).toEqual({
    kind: "ready",
    catalog: {
      formatVersion: 1,
      environments: [
        {
          environmentId: "environment",
          pinnedIdentity: null,
          preferredRouteId: null,
          routes: [
            { ...first, status: { kind: "untested" } },
            { ...second, status: { kind: "untested" } },
          ],
        },
      ],
    },
  });
  expect(migrateRouteCatalog(null)).toEqual({
    kind: "ready",
    catalog: { formatVersion: 1, environments: [] },
  });
});

test("future formats and invalid bindings leave the supplied catalog intact", () => {
  const future = { formatVersion: 2, futureData: "retained" };
  expect(migrateRouteCatalog(future)).toEqual({ kind: "unsupportedFormat", formatVersion: 2 });
  expect(future).toEqual({ formatVersion: 2, futureData: "retained" });
  for (const invalid of [
    { ...catalog, environments: [{ ...catalog.environments[0], preferredRouteId: "absent" }] },
    { ...catalog, environments: [{ ...catalog.environments[0], routes: [first, first] }] },
    {
      ...catalog,
      environments: [
        {
          ...catalog.environments[0],
          pinnedIdentity: { id: "other", publicKey: "A".repeat(87), keyVersion: 1 },
        },
      ],
    },
    {
      ...catalog,
      environments: [
        { ...catalog.environments[0], routes: [{ ...first, environmentId: "other" }] },
      ],
    },
    [{ ...first, privateKey: "secret" }],
  ])
    expect(migrateRouteCatalog(invalid)).toEqual({ kind: "invalidCatalog" });
});

test("route trust diagnostics preserve their failure stage without raw proofs", () => {
  const context = { routeId: "route", environmentId: "environment", observedAt: 10 };
  for (const detail of [
    { stage: "tlsCertificate", reason: "untrusted" },
    { stage: "sshHostKey", reason: "keyChanged" },
    { stage: "environmentIdentity", reason: "invalidSignature" },
    {
      stage: "protocolVersion",
      reason: "unsupportedProtocolVersion",
      localVersion: { major: 1, minor: 0 },
      remoteVersion: { major: 2, minor: 0 },
    },
  ])
    expect(v.safeParse(RouteDiagnosticSchema, { ...context, detail }).success).toBe(true);
  expect(
    v.safeParse(RouteDiagnosticSchema, {
      ...context,
      detail: { stage: "environmentIdentity", reason: "invalidSignature", signature: "raw" },
    }).success,
  ).toBe(false);
});

test("route peers share upgrade, close and scheduling constants", () => {
  expect(BUSINESS_WEBSOCKET_PATH).toBe("/ws");
  expect(BUSINESS_CLOSE_CODES).toEqual({ normal: 1000, cancelledAttempt: 4000, revoked: 4001 });
  expect(ROUTE_LIMITS).toMatchObject({
    preferredHeadStartMs: 500,
    maxConcurrentProbes: 4,
    identityTimeoutMs: 2500,
    authenticationTimeoutMs: 15000,
    configurationIdleTimeoutMs: 75000,
    sshBindAttempts: 3,
    sshReadyTimeoutMs: 15000,
  });
});
