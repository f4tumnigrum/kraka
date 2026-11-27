import { hasMethodPermissions } from "./requests";
import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  DEFAULT_DEVICE_PERMISSIONS,
  PERMISSION_ITEMS,
  PermissionGrantSchema,
  PermissionSetSchema,
  PrincipalSchema,
  withinPrincipalCeiling,
} from "./access";
import { ThreadIdSchema } from "./ids";
import { PairingRequestSchema, REQUEST_METHODS, type RequestMethodDefinition } from "./requests";

describe("protocol authorization shapes", () => {
  test("pairs a new device with all nine default permissions", () => {
    expect(DEFAULT_DEVICE_PERMISSIONS).toHaveLength(9);
    expect(new Set(PERMISSION_ITEMS).size).toBe(PERMISSION_ITEMS.length);
    expect(REQUEST_METHODS.upgradeEnvironment.permission).toBe("environment.upgrade");
    expect(
      hasMethodPermissions(REQUEST_METHODS.upgradeEnvironment, new Set(DEFAULT_DEVICE_PERMISSIONS)),
    ).toBe(false);
    expect(v.safeParse(PermissionSetSchema, ["thread.view", "unknown.permission"]).success).toBe(
      false,
    );

    const request = v.parse(PairingRequestSchema, {
      kind: "pairing.request",
      environmentId: "environment-1",
      inviteId: "invite-1",
      requestId: "pairing-request-1",
      deviceId: "device-1",
      publicKey: "A".repeat(87),
      target: { kind: "project", projectId: "project-1" },
    });
    expect(request.requestedPermissions).toEqual([...DEFAULT_DEVICE_PERMISSIONS]);
  });

  test("keeps device, executor and reserved principal kinds distinct", () => {
    expect(
      v.parse(PrincipalSchema, {
        kind: "device",
        id: "principal-device",
        deviceId: "device-1",
        ownerId: "principal-owner",
      }).kind,
    ).toBe("device");
    expect(
      v.parse(PrincipalSchema, {
        kind: "executor",
        id: "principal-executor",
        executorInstanceId: "executor-1",
        threadId: "thread-1",
        attemptId: "attempt-1",
      }).kind,
    ).toBe("executor");
    expect(
      v.parse(PrincipalSchema, { kind: "guest", id: "principal-guest", sharedThreadId: "thread-2" })
        .kind,
    ).toBe("guest");
    expect(
      v.parse(PrincipalSchema, { kind: "scheduledJob", id: "principal-job", trigger: "timer" })
        .kind,
    ).toBe("scheduledJob");
    expect(
      v.safeParse(PrincipalSchema, {
        kind: "device",
        id: "principal-device",
        deviceId: "device-1",
        ownerId: "principal-owner",
        unrecognized: true,
      }).success,
    ).toBe(false);
  });

  test("keeps executor signers inside their thread and kind ceiling", () => {
    const executor = v.parse(PrincipalSchema, {
      kind: "executor",
      id: "principal-executor",
      executorInstanceId: "executor-1",
      threadId: "thread-1",
      attemptId: "attempt-1",
    });
    if (executor.kind !== "executor") throw new Error("Expected executor principal.");
    const ownThreadId = v.parse(ThreadIdSchema, "thread-1");
    const otherThreadId = v.parse(ThreadIdSchema, "thread-2");

    expect(
      withinPrincipalCeiling(executor, { kind: "thread", threadId: ownThreadId }, "thread.send"),
    ).toBe(true);
    expect(
      withinPrincipalCeiling(executor, { kind: "thread", threadId: otherThreadId }, "thread.send"),
    ).toBe(false);
    expect(
      withinPrincipalCeiling(executor, { kind: "thread", threadId: ownThreadId }, "access.give"),
    ).toBe(false);
    expect(
      withinPrincipalCeiling(executor, { kind: "thread", threadId: ownThreadId }, "owner.decide"),
    ).toBe(false);
  });

  test("attaches the required permission to every signed method", () => {
    expect(REQUEST_METHODS.startThread.permission).toBe("thread.send");
    expect(REQUEST_METHODS.releaseQueue.permission).toBe("thread.send");
    expect(REQUEST_METHODS.answerTodo.permission).toBe("thread.reply");
    expect(REQUEST_METHODS.decideTodo.permission).toBe("owner.decide");
    expect(REQUEST_METHODS.openThreadSubscription.permission).toBe("thread.view");
    expect(REQUEST_METHODS.readHistoryPage.permission).toBe("thread.view");
    expect(REQUEST_METHODS.approveDevicePairing.permission).toBe("access.give");
    expect(REQUEST_METHODS.inviteDevice.permission).toBe("access.give");
    expect(
      Object.values(REQUEST_METHODS).every((method) =>
        PERMISSION_ITEMS.includes(method.permission),
      ),
    ).toBe(true);

    const complete: RequestMethodDefinition = {
      method: "sample.read",
      permission: "thread.view",
      target: "thread",
      schema: v.string(),
    };
    void complete;

    // @ts-expect-error method definitions must carry their required permission
    const missingPermission: RequestMethodDefinition = {
      method: "sample.read",
      target: "thread",
      schema: v.string(),
    };
    void missingPermission;
  });

  test("rejects grants with unknown fields or rights", () => {
    const grant = {
      id: "grant-1",
      target: { kind: "thread", threadId: "thread-1" },
      principalId: "principal-1",
      permission: "thread.view",
      inheritance: "targetOnly",
      modeCeiling: "ask",
      grantedBy: { kind: "device", deviceId: "device-owner", principalId: "principal-owner" },
    };

    expect(v.safeParse(PermissionGrantSchema, grant).success).toBe(true);
    expect(v.safeParse(PermissionGrantSchema, { ...grant, unexpected: true }).success).toBe(false);
    expect(v.safeParse(PermissionGrantSchema, { ...grant, permission: "file.write" }).success).toBe(
      false,
    );
  });
});
