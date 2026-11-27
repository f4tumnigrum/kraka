import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  BrowserProfileSchema,
  BrowserProfilesSchema,
  DESKTOP_IPC,
  DesktopPortMappingSchema,
  PortAuthorizationTicketSchema,
  PortObservationSchema,
  PortServiceSchema,
  PortUrlProbeResultSchema,
  PreviewAddressSchema,
  PreviewElementReferenceSchema,
  PreviewTabSnapshotSchema,
  PreviewWaitSchema,
  isCurrentPreviewElement,
  matchesPortService,
} from "./index";

const generation = "d244f6ea-aff7-4b14-9129-59858bf19c1a";
const address = {
  environmentId: "environment",
  environmentGeneration: generation,
  threadId: "thread",
  host: { kind: "environmentBrowser" },
  hostGeneration: "browser-process",
  tabId: "c0596ed5-4886-43cb-8733-54cc228fd0c4",
};
const profile = {
  environmentId: "environment",
  host: { kind: "environmentBrowser" },
  profileId: "default",
  name: "Default",
  storage: { kind: "persistent", partition: "environment-default" },
};
const service = {
  environmentId: "environment",
  environmentGeneration: generation,
  serviceId: "development-service",
  port: 3000,
  process: { pid: 7201, startedAt: 100 },
};

test("a listener remains web-unverified until an explicit configured URL responds", () => {
  const observed = {
    environmentId: "environment",
    environmentGeneration: generation,
    port: 3000,
    observedAt: 101,
    kind: "listening",
    ownership: { kind: "unverified", reason: "registrationMissing" },
    web: "unverified",
  };
  expect(v.safeParse(PortObservationSchema, observed).success).toBe(true);
  expect(v.safeParse(PortObservationSchema, { ...observed, web: "reachable" }).success).toBe(false);
  expect(
    v.safeParse(PortUrlProbeResultSchema, {
      environmentId: "environment",
      projectId: "project",
      configuredUrl: "http://localhost:3000/health",
      checkedAt: 102,
      result: { kind: "responded", status: 503 },
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(PortObservationSchema, {
      ...observed,
      ownership: {
        kind: "verified",
        projectId: "project",
        threadId: "thread",
        serviceId: "service",
        process: { pid: 7201 },
        registration: { kind: "developmentProcess" },
      },
    }).success,
  ).toBe(false);
});

test("reusing the same PID or port cannot preserve a replaced service identity", () => {
  const expected = v.parse(PortServiceSchema, service);
  expect(matchesPortService(expected, v.parse(PortServiceSchema, service))).toBe(true);
  for (const replacement of [
    { ...service, environmentId: "other-environment" },
    { ...service, environmentGeneration: "d244f6ea-aff7-4b14-9129-59858bf19c1b" },
    { ...service, process: { pid: 7201, startedAt: 200 } },
    { ...service, serviceId: "replacement-service" },
  ])
    expect(matchesPortService(expected, v.parse(PortServiceSchema, replacement))).toBe(false);
});

test("desktop forwarding accepts a service-bound ticket and returns its actual loopback port", () => {
  const ticket = {
    id: "ticket",
    token: "A".repeat(43),
    deviceId: "desktop",
    connectionId: "connection",
    service,
    issuedAt: 100,
    expiresAt: 60_100,
  };
  expect(v.safeParse(DESKTOP_IPC.forwardDevelopmentPort.input, { ticket }).success).toBe(true);
  expect(
    v.safeParse(PortAuthorizationTicketSchema, {
      ...ticket,
      service: { ...service, host: "other-host" },
    }).success,
  ).toBe(false);
  const { connectionId, ...unbound } = ticket;
  expect(connectionId).toBe("connection");
  expect(v.safeParse(PortAuthorizationTicketSchema, unbound).success).toBe(false);
  const mapping = {
    id: "mapping",
    deviceId: "desktop",
    desktopInstanceId: "desktop-process",
    service,
    localHost: "127.0.0.1",
    localPort: 49152,
    createdAt: 102,
    state: { kind: "active" },
  };
  expect(
    v.parse(DESKTOP_IPC.forwardDevelopmentPort.result, { kind: "forwarded", mapping }),
  ).toMatchObject({ mapping: { localPort: 49152 } });
  expect(v.safeParse(DesktopPortMappingSchema, { ...mapping, localHost: "0.0.0.0" }).success).toBe(
    false,
  );
  expect(
    v.safeParse(DESKTOP_IPC.stopDevelopmentPortMapping.input, {
      environmentId: "environment",
      mappingId: "mapping",
    }).success,
  ).toBe(true);
});

test("preview state keeps loading, visibility, availability and control independent", () => {
  const snapshot = {
    address,
    stateVersion: "1",
    title: "http://localhost:3000",
    profile,
    availability: "available",
    visibility: "hidden",
    navigation: {
      kind: "loadFailed",
      navigationId: "navigation",
      requestedUrl: "http://localhost:3000",
      sampledAt: 100,
      reason: "network",
    },
    control: {
      epoch: "3",
      owner: { kind: "human", deviceId: "phone", connectionId: "connection" },
    },
  };
  const { name, storage, ...identity } = profile;
  expect(name).toBe("Default");
  expect(storage.kind).toBe("persistent");
  const decoded = v.parse(PreviewTabSnapshotSchema, { ...snapshot, profile: identity });
  expect(decoded.navigation.kind).toBe("loadFailed");
  expect(decoded.availability).toBe("available");
  expect(v.safeParse(PreviewAddressSchema, { ...address, tabId: "old-tab" }).success).toBe(false);
});

test("element dispatch rejects replaced hosts, documents, snapshots and control epochs", () => {
  const reference = v.parse(PreviewElementReferenceSchema, {
    address,
    navigationId: "navigation",
    snapshotId: "snapshot",
    controlEpoch: "1",
    elementId: "button",
  });
  expect(isCurrentPreviewElement(reference, reference)).toBe(true);
  for (const changed of [
    {
      ...reference,
      address: v.parse(PreviewAddressSchema, { ...address, environmentId: "other" }),
    },
    {
      ...reference,
      address: v.parse(PreviewAddressSchema, {
        ...address,
        environmentGeneration: "d244f6ea-aff7-4b14-9129-59858bf19c1b",
      }),
    },
    {
      ...reference,
      address: v.parse(PreviewAddressSchema, { ...address, hostGeneration: "new-process" }),
    },
    {
      ...reference,
      address: v.parse(PreviewAddressSchema, {
        ...address,
        host: { kind: "desktopBrowser", deviceId: "desktop" },
      }),
    },
    v.parse(PreviewElementReferenceSchema, { ...reference, navigationId: "next-navigation" }),
    v.parse(PreviewElementReferenceSchema, { ...reference, snapshotId: "next-snapshot" }),
    v.parse(PreviewElementReferenceSchema, { ...reference, controlEpoch: "3" }),
  ])
    expect(isCurrentPreviewElement(reference, changed)).toBe(false);
});

test("conditional waits require at least one condition and default to ten seconds", () => {
  const wait = {
    commandId: "wait",
    address,
    navigationId: "navigation",
    conditions: [
      { kind: "text", text: "Ready" },
      { kind: "url", url: "http://localhost:3000/ready" },
    ],
  };
  expect(v.parse(PreviewWaitSchema, wait).timeoutMs).toBe(10_000);
  expect(v.safeParse(PreviewWaitSchema, { ...wait, conditions: [] }).success).toBe(false);
  expect(v.parse(PreviewWaitSchema, { ...wait, timeoutMs: 10_001 }).timeoutMs).toBe(10_001);
  expect(v.safeParse(PreviewWaitSchema, { ...wait, timeoutMs: 0 }).success).toBe(false);
});

test("profile records bind environment and loading host and keep incognito ephemeral", () => {
  expect(v.safeParse(BrowserProfileSchema, profile).success).toBe(true);
  expect(
    v.safeParse(BrowserProfileSchema, {
      ...profile,
      storage: { kind: "ephemeral", incognito: true },
    }).success,
  ).toBe(true);
  expect(
    v.safeParse(BrowserProfileSchema, {
      ...profile,
      storage: { ...profile.storage, incognito: true },
    }).success,
  ).toBe(false);
  expect(
    v.safeParse(BrowserProfileSchema, { ...profile, host: { kind: "desktopBrowser" } }).success,
  ).toBe(false);
  expect(v.safeParse(BrowserProfileSchema, { ...profile, name: "x".repeat(49) }).success).toBe(
    false,
  );
  expect(v.safeParse(BrowserProfileSchema, { ...profile, cookies: [] }).success).toBe(false);
  expect(
    v.safeParse(
      BrowserProfilesSchema,
      Array.from({ length: 25 }, () => profile),
    ).success,
  ).toBe(false);
});
