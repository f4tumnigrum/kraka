import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import {
  CommandIdSchema,
  EnvironmentSessionIdSchema,
  StoredRegistrationSchema,
} from "@kraka/protocol";
import type { LoginFlow } from "./executor-records";
import { InstanceLogins, loginTable } from "./instance-login";

const registration = v.parse(StoredRegistrationSchema, {
  family: "codex",
  instanceId: "A",
  version: "1",
  displayName: "A",
  enabled: true,
  driver: {
    executable: "fixture",
    endpoint: null,
    configurationRoot: "profile",
    historyRoot: "history",
    variables: {},
  },
  credential: { ownerId: "owner", namespace: "A", key: "profile", version: "1" },
  model: null,
  permission: { ceiling: "ask", selected: "ask" },
});
const flow: LoginFlow = {
  flowId: v.parse(CommandIdSchema, "login-command"),
  instanceId: registration.instanceId,
  ownerSessionId: v.parse(EnvironmentSessionIdSchema, "original"),
  credential: registration.credential,
  configVersion: registration.version,
  expiresAt: 600100,
  expectedAccount: "account@example.invalid",
  interaction: "deviceCode",
};
const interaction = {
  kind: "deviceCode",
  url: "https://example.invalid/private-url",
  userCode: "SYNTHETIC-PRIVATE-CODE",
} as const;
let db: Database, logins: InstanceLogins;
let current = registration;
beforeEach(() => {
  current = registration;
  db = new Database(":memory:");
  db.exec(loginTable);
  logins = new InstanceLogins(db, () => current);
  expect(logins.begin(flow, 100)).toMatchObject({ kind: "created", flow: { expiresAt: 600100 } });
});
afterEach(() => db.close(true));
const advance = (event: Parameters<InstanceLogins["advanceLogin"]>[0]["event"], now = 200) =>
  logins.advanceLogin({ ...flow, expectedCredential: flow.credential, now, event });
const start = (expiresAt = 400) =>
  advance({ kind: "started", nativeLoginId: "provider-opaque", interaction, expiresAt }, 101);
const callback = { kind: "callback", nativeLoginId: "provider-opaque", success: true } as const;
const probe = (account = flow.expectedAccount) =>
  ({
    kind: "probe",
    authentication: { status: { state: "yes", verifiedAt: 200 }, account },
  }) as const;
const read = (session = flow.ownerSessionId, now = 200) =>
  logins.read(flow.flowId, flow.instanceId, session, now);
test("Cancellation wins over a late callback", () => {
  start();
  expect(advance({ kind: "cancel" })?.record.phase).toBe("cancelled");
  expect(advance(callback)?.applied).toBe(false);
  expect(advance(probe())?.applied).toBe(false);
  expect(read()).toMatchObject({ phase: "cancelled", interaction: null });
});
test("Another device cannot read the code", () => {
  start();
  const other = v.parse(EnvironmentSessionIdSchema, "another");
  expect(read()?.interaction).toEqual(interaction);
  expect(read(other)).toMatchObject({ phase: "deviceCode", interaction: null });
  expect(
    logins.advanceLogin({
      ...flow,
      ownerSessionId: other,
      expectedCredential: flow.credential,
      now: 200,
      event: { kind: "cancel" },
    }),
  ).toBeNull();
  expect(logins.begin(flow, 201)).toMatchObject({ kind: "existing", flow: { expiresAt: 400 } });
  expect(logins.begin({ ...flow, ownerSessionId: other }, 201).kind).toBe("conflict");
  const row = db.query<{ data: string }, []>("SELECT data FROM instance_logins").get();
  expect(row?.data).not.toContain(interaction.url);
  expect(row?.data).not.toContain(interaction.userCode);
});
test("A stale probe cannot authorize the replacement account", () => {
  start();
  expect(advance(callback)?.record.phase).toBe("verifying");
  current = v.parse(StoredRegistrationSchema, {
    ...registration,
    version: "2",
    credential: { ...registration.credential, version: "2" },
  });
  expect(advance(probe())?.record.phase).toBe("failed");
  const next = {
    ...flow,
    configVersion: current.version,
    credential: current.credential,
    flowId: v.parse(CommandIdSchema, "replacement"),
  };
  const step = (event: Parameters<typeof advance>[0]) =>
    logins.advanceLogin({ ...next, expectedCredential: next.credential, now: 200, event });
  expect(logins.begin(next, 200).kind).toBe("created");
  step({ kind: "started", nativeLoginId: "new-opaque", interaction, expiresAt: 400 });
  step({ ...callback, nativeLoginId: "new-opaque" });
  expect(step(probe())?.record.phase).toBe("authenticated");
  expect(read()?.phase).toBe("failed");
});
test("Expiry applies at the deadline, including while verifying", () => {
  start();
  expect(read(flow.ownerSessionId, 399)?.phase).toBe("deviceCode");
  advance(callback, 399);
  expect(advance(probe(), 400)?.record.phase).toBe("expired");
  expect(read()).toMatchObject({ phase: "expired", interaction: null });
});
test("A provider without a deadline expires at the ten-minute fallback", () => {
  start(flow.expiresAt);
  expect(read(flow.ownerSessionId, flow.expiresAt - 1)?.phase).toBe("deviceCode");
  expect(read(flow.ownerSessionId, flow.expiresAt)?.phase).toBe("expired");
  expect(advance(callback, flow.expiresAt + 1)?.applied).toBe(false);
});
test("Restart invalidates the challenge and returns the profile for an independent account probe", () => {
  start();
  const reopened = new InstanceLogins(db, () => current);
  expect(reopened.recover()).toMatchObject([{ flowId: flow.flowId, credential: flow.credential }]);
  expect(reopened.read(flow.flowId, flow.instanceId, flow.ownerSessionId, 200)).toMatchObject({
    phase: "failed",
    reason: "Daemon restarted",
    interaction: null,
  });
  expect(reopened.recover()).toEqual([]);
  expect(reopened.pendingAccountChecks()).toHaveLength(1);
  reopened.accountChecked(flow.flowId);
  expect(reopened.pendingAccountChecks()).toEqual([]);
});
test("Completion checks the opaque ID and independently observed identity", () => {
  start();
  expect(advance({ ...callback, nativeLoginId: "other" })?.applied).toBe(false);
  expect(advance(callback)?.record.phase).toBe("verifying");
  expect(advance(probe("other@example.invalid"))?.record).toMatchObject({
    phase: "failed",
    reason: "Unexpected account",
  });
});
