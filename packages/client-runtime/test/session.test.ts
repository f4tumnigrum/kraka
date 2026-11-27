import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  DeviceRegistrationSchema,
  DevicePairingResultSchema,
  EnvironmentIdentitySchema,
  CommandIdSchema,
  migrateRouteCatalog,
  RouteSchema,
} from "@kraka/protocol";
import {
  selectBrowserRoute,
  completeLocalPairing,
  planIdentityPin,
  unavailableOnlineRead,
} from "../src";

const identity = v.parse(EnvironmentIdentitySchema, {
  id: "env",
  publicKey: "A".repeat(87),
  keyVersion: 1,
});
const origin = "https://dev.example.test";
const old = {
  environmentId: identity.id,
  kind: "lan",
  secureContext: true,
  status: { kind: "reachable", checkedAt: 1 },
};
const routes = [
  { ...old, id: "other", endpoint: "https://other.test" },
  { ...old, id: "lan", endpoint: origin },
  { ...old, id: "mesh", endpoint: origin, kind: "userMesh" },
];
const entry = {
  environmentId: identity.id,
  pinnedIdentity: identity,
  preferredRouteId: "other",
  routes,
};
const catalog = (row: unknown) => migrateRouteCatalog({ formatVersion: 1, environments: [row] });
const snapshot = (raw: unknown) => {
  const result = catalog(raw);
  if (result.kind !== "ready") throw Error("Expected valid catalog");
  return result.catalog;
};
const input = {
  actualOrigin: origin,
  pageOrigin: "https://DEV.example.test:443/",
  secureContext: true,
  subtleAvailable: true,
  selectedEnvironmentId: identity.id,
  expectedIdentity: identity,
  catalog: catalog(entry),
  offeredCatalog: snapshot(entry),
  generation: 4,
};
test("the live origin and current pin choose one matching route before dialing", () => {
  expect(selectBrowserRoute(input, URL)).toMatchObject({
    kind: "selected",
    routeId: "lan",
    generation: 4,
  });
  expect(
    selectBrowserRoute(
      {
        ...input,
        offeredCatalog: snapshot({ ...entry, preferredRouteId: "mesh" }),
        catalog: catalog({ ...entry, preferredRouteId: "mesh" }),
      },
      URL,
    ),
  ).toMatchObject({ routeId: "mesh" });
  for (const [overrides, reason] of [
    [{ pageOrigin: "https://dev.example.test." }, "originMismatch"],
    [{ secureContext: false }, "insecureContext"],
    [{ subtleAvailable: false }, "insecureContext"],
    [{ offeredCatalog: snapshot({ ...entry, preferredRouteId: "mesh" }) }, "catalogChanged"],
    [{ catalog: catalog({ ...entry, pinnedIdentity: null }) }, "pairingRequired"],
    [{ expectedIdentity: { ...identity, keyVersion: 2 } }, "identityConflict"],
    [
      {
        offeredCatalog: snapshot({ ...entry, routes: routes.slice(0, 1) }),
        catalog: catalog({ ...entry, routes: routes.slice(0, 1) }),
      },
      "noSameOriginRoute",
    ],
    [{ catalog: migrateRouteCatalog({ formatVersion: 9 }) }, "unsupportedFormat"],
  ] as const)
    expect(selectBrowserRoute({ ...input, ...overrides }, URL)).toEqual({
      kind: "unavailable",
      reason,
      generation: 4,
    });
  const loaded = catalog(entry);
  if (loaded.kind !== "ready") throw Error("Expected migrated catalog");
  const migrated = loaded.catalog.environments[0]?.routes[0];
  expect(migrated).toMatchObject({ lastObservedSecureContext: true, status: { kind: "untested" } });
  expect(migrated).not.toHaveProperty("secureContext");
  for (const port of [0, 65536, 99999])
    expect(v.is(RouteSchema, { ...migrated, endpoint: `${origin}:${port}` })).toBe(false);
  expect(v.is(RouteSchema, { ...migrated, endpoint: `${origin}:65535` })).toBe(true);
});
test("pinning is scoped to the confirmed origin and preserves the first committed identity", () => {
  const empty = migrateRouteCatalog(null);
  if (empty.kind !== "ready") throw Error("Expected empty catalog");
  const confirmed = {
    origin,
    environmentId: identity.id,
    verifiedIdentity: identity,
    confirmed: true,
  } as const;
  const first = planIdentityPin(origin, empty.catalog, confirmed, URL);
  if (first.kind !== "commit") throw Error("Expected a new pin");
  expect(planIdentityPin(origin, first.catalog, confirmed, URL).kind).toBe("alreadyPinned");
  expect(
    planIdentityPin(
      origin,
      first.catalog,
      { ...confirmed, verifiedIdentity: { ...identity, keyVersion: 2 } },
      URL,
    ).kind,
  ).toBe("conflict");
  expect(planIdentityPin("https://other.test", empty.catalog, confirmed, URL).kind).toBe(
    "conflict",
  );
});
test("pairing checks the original claim, device key, authority and expiry before replacing pending metadata", () => {
  const pending = v.parse(DeviceRegistrationSchema, {
    kind: "pendingExchange",
    identity,
    deviceId: "dev",
    keyId: "key",
    publicKey: "B".repeat(87),
    target: { kind: "project", projectId: "project" },
    claimId: "claim",
    inviteId: "invite",
    requestId: "request",
    requestedPermissions: ["thread.view"],
  });
  const completed = v.parse(DevicePairingResultSchema, {
    kind: "pairing.completed",
    requestId: "request",
    principal: { kind: "device", id: "p", ownerId: "owner", deviceId: "dev" },
    deviceKey: {
      id: "key",
      deviceId: "dev",
      publicKey: pending.publicKey,
      state: { kind: "usable", expiresAt: 20 },
    },
    permissions: ["thread.view"],
  });
  if (pending.kind !== "pendingExchange" || completed.kind !== "pairing.completed")
    throw Error("Unexpected fixture");
  const result = completeLocalPairing(pending, pending, identity, completed, 19);
  if (result.kind !== "store") throw Error("Expected store");
  expect(result.registration).not.toHaveProperty("claimId");
  expect(completeLocalPairing(result.registration, pending, identity, completed, 19).kind).toBe(
    "alreadyRegistered",
  );
  expect(completeLocalPairing(pending, pending, identity, completed, 20).kind).toBe("conflict");
  for (const change of [
    { ...completed, permissions: ["thread.send"] as typeof completed.permissions },
    {
      ...completed,
      principal: {
        ...completed.principal,
        deviceId: v.parse(DeviceRegistrationSchema, { ...pending, deviceId: "foreign" }).deviceId,
      },
    },
    { ...completed, deviceKey: { ...completed.deviceKey, publicKey: identity.publicKey } },
  ])
    expect(completeLocalPairing(pending, pending, identity, change, 19).kind).toBe("conflict");
  expect(
    completeLocalPairing({ ...pending, claimId: null }, pending, identity, completed, 19).kind,
  ).toBe("conflict");
});
test("an online read before configuration immediately carries the original command ID", () => {
  const commandId = v.parse(CommandIdSchema, "read");
  expect(unavailableOnlineRead({ generation: 1, phase: "opening" }, commandId)).toMatchObject({
    kind: "unavailable",
    commandId: "read",
    snapshot: { phase: "opening" },
  });
});
