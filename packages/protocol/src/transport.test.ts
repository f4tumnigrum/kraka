import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  CommandReceiptSchema,
  SessionAuthorizedSchema,
  SessionConfigurationSchema,
  SignedRequestSchema,
} from "./requests";
import {
  PrincipalIdSchema,
  DeviceKeyIdSchema,
  ConnectionIdSchema,
  EnvironmentIdSchema,
  SyncCursorSchema,
} from "./ids";
import { TRANSPORT_LIMITS } from "./transport-limits";
import {
  ContentChunkHeaderSchema,
  FlowWindowSchema,
  HistoryPageSchema,
  ObjectChangeSchema,
  ServerHelloSchema,
  matchesAuthorizedConfiguration,
  TransportFrameHeaderSchema,
  isValidFlowWindow,
  readBinaryContent,
  readSubscriptionPage,
} from "./transport";

const stopRequest = {
  kind: "signedRequest",
  protocolVersion: { major: 1, minor: 0 },
  environmentId: "environment-1",
  connectionId: "connection-1",
  challengeId: "challenge-1",
  challenge: "A".repeat(43),
  signer: { kind: "device", deviceId: "device-1", keyId: "device-key-1" },
  sequence: 1,
  commandId: "command-1",
  method: "round.stop",
  payload: { threadId: "thread-1", attemptId: "attempt-1" },
  signature: "A".repeat(86),
} as const;

describe("wire protocol messages", () => {
  test("checks the server identity proof fields and negotiated feature names", () => {
    const hello = v.parse(ServerHelloSchema, {
      kind: "server.hello",
      connectionId: "connection-1",
      challengeId: "challenge-1",
      challenge: "B".repeat(43),
      clientNonce: "A".repeat(43),
      protocolVersion: { major: 1, minor: 0 },
      features: ["strictSchemas", "signedRequests"],
      identity: { id: "environment-1", publicKey: "C".repeat(87), keyVersion: 1 },
      identityProof: "D".repeat(86),
    });
    expect(hello.identity.id.toString()).toBe("environment-1");
    expect(v.safeParse(ServerHelloSchema, { ...hello, features: ["futureFeature"] }).success).toBe(
      false,
    );
  });

  test("sends the initial flow budgets with the session configuration", () => {
    const configuration = v.parse(SessionConfigurationSchema, {
      kind: "session.configuration",
      connectionId: "connection-1",
      environmentSessionId: "environment-session-1",
      environment: { id: "environment-1", version: "1" },
      version: "1",
      executors: [],
      transportLimits: TRANSPORT_LIMITS,
    });

    const desktop = {
      owner: "desktop",
      platform: "macos",
      onLastWindow: "keepRunning",
      onDesktopQuit: "stop",
    };
    expect(
      v.safeParse(SessionConfigurationSchema, { ...configuration, description: desktop }).success,
    ).toBe(true);
    expect(
      v.safeParse(SessionConfigurationSchema, {
        ...configuration,
        description: { ...desktop, platform: "windows" },
      }).success,
    ).toBe(false);
    expect(configuration.transportLimits.maxActiveDataStreams).toBe(32);
    expect(configuration.transportLimits.maxPendingConnectionBytes).toBe(65_536);
    expect(
      v.safeParse(SessionConfigurationSchema, {
        kind: "session.configuration",
        connectionId: "connection-1",
        environmentSessionId: "environment-session-1",
        environment: { id: "environment-1", version: "1" },
        version: "1",
        executors: [],
        transportLimits: { ...TRANSPORT_LIMITS, maxActiveDataStreams: 33 },
      }).success,
    ).toBe(false);
  });

  test("rejects a configuration bound to a different connection, session or environment", () => {
    const hello = v.parse(ServerHelloSchema, {
      kind: "server.hello",
      connectionId: "connection-1",
      challengeId: "challenge-1",
      challenge: "B".repeat(43),
      clientNonce: "A".repeat(43),
      protocolVersion: { major: 1, minor: 0 },
      features: ["strictSchemas"],
      identity: { id: "environment-1", publicKey: "C".repeat(87), keyVersion: 1 },
      identityProof: "D".repeat(86),
    });
    const authorized = v.parse(SessionAuthorizedSchema, {
      kind: "session.authorized" as const,
      environmentId: "environment-1",
      connectionId: "connection-1",
      environmentSessionId: "environment-session-1",
      principal: {
        kind: "device" as const,
        id: "principal-1",
        deviceId: "device-1",
        ownerId: "owner-1",
      },
      signer: { kind: "device" as const, deviceId: "device-1", keyId: "device-key-1" },
      authorizedAt: 1,
      protocolVersion: { major: 1, minor: 0 },
      features: ["strictSchemas"],
    });
    const configuration = v.parse(SessionConfigurationSchema, {
      kind: "session.configuration",
      connectionId: "connection-1",
      environmentSessionId: "environment-session-1",
      environment: { id: "environment-1", version: "1" },
      version: "1",
      executors: [],
      transportLimits: TRANSPORT_LIMITS,
    });

    const registration = v.parse(SessionAuthorizedSchema, { ...authorized });
    for (const substitute of [
      { ...authorized, environmentId: v.parse(EnvironmentIdSchema, "another") },
      {
        ...authorized,
        principal: { ...authorized.principal, id: v.parse(PrincipalIdSchema, "other") },
      },
      {
        ...authorized,
        signer: { ...authorized.signer, keyId: v.parse(DeviceKeyIdSchema, "other") },
      },
      { ...authorized, protocolVersion: { major: 1, minor: 1 } },
      { ...authorized, features: [] },
      { ...authorized, features: ["strictSchemas", "strictSchemas"] },
      { ...authorized, connectionId: "another-connection" },
      { ...authorized, environmentSessionId: "another-session" },
      { ...authorized, principal: { ...authorized.principal, deviceId: "other-device" } },
      { ...authorized, signer: { ...authorized.signer, deviceId: "other-device" } },
      { ...authorized, principal: { ...authorized.principal, ownerId: "other-owner" } },
    ]) {
      const changed = v.parse(SessionAuthorizedSchema, substitute);
      expect(matchesAuthorizedConfiguration(hello, changed, configuration, registration)).toBe(
        false,
      );
    }
    expect(matchesAuthorizedConfiguration(hello, authorized, configuration, registration)).toBe(
      true,
    );
    expect(
      matchesAuthorizedConfiguration(
        hello,
        authorized,
        {
          ...configuration,
          environment: {
            ...configuration.environment,
            id: v.parse(EnvironmentIdSchema, "environment-2"),
          },
        },
        registration,
      ),
    ).toBe(false);
  });

  test("accepts a signed method and rejects unknown fields or methods", () => {
    const upgrade = {
      ...stopRequest,
      method: "environment.upgrade",
      payload: { targetVersion: "2.0.0" },
    };
    expect(v.parse(SignedRequestSchema, upgrade).method).toBe("environment.upgrade");
    expect(
      v.safeParse(SignedRequestSchema, { ...upgrade, payload: { targetVersion: "../outside" } })
        .success,
    ).toBe(false);
    expect(v.parse(SignedRequestSchema, stopRequest).method).toBe("round.stop");
    expect(v.safeParse(SignedRequestSchema, { ...stopRequest, unexpected: true }).success).toBe(
      false,
    );
    expect(
      v.safeParse(SignedRequestSchema, { ...stopRequest, method: "round.delete" }).success,
    ).toBe(false);
  });

  test("keeps accepted, rejected and program-error receipts separate", () => {
    expect(
      v.parse(CommandReceiptSchema, {
        kind: "accepted",
        commandId: "command-1",
        result: { kind: "actionAccepted" },
      }).kind,
    ).toBe("accepted");
    expect(
      v.parse(CommandReceiptSchema, {
        kind: "rejected",
        commandId: "command-2",
        failure: { kind: "invalidState" },
      }).kind,
    ).toBe("rejected");
    expect(
      v.parse(CommandReceiptSchema, {
        kind: "programError",
        commandId: "command-3",
        code: "internalError",
      }).kind,
    ).toBe("programError");
  });

  test("rejects unknown transport kinds and bounds per-stream byte windows", () => {
    expect(
      v.safeParse(TransportFrameHeaderSchema, {
        lane: "control",
        epoch: "connection-1",
        streamId: 0,
        offsetBytes: 0,
        message: { kind: "unknown.message" },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(FlowWindowSchema, {
        lane: "window",
        epoch: "connection-1",
        streamId: 1,
        consumedBytes: 4_096,
        limitBytes: 8_192,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(FlowWindowSchema, {
        lane: "window",
        epoch: "connection-1",
        streamId: 1,
        consumedBytes: -1,
        limitBytes: 8_192,
      }).success,
    ).toBe(false);
    expect(
      isValidFlowWindow({
        lane: "window",
        epoch: v.parse(ConnectionIdSchema, "connection-1"),
        streamId: 1,
        consumedBytes: 8,
        limitBytes: 8,
      }),
    ).toBe(true);
    expect(
      isValidFlowWindow({
        lane: "window",
        epoch: v.parse(ConnectionIdSchema, "connection-1"),
        streamId: 1,
        consumedBytes: 9,
        limitBytes: 8,
      }),
    ).toBe(false);
  });

  test("bounds each attachment chunk and rejects unknown object changes", () => {
    const contentHeader = {
      kind: "content.chunk",
      transferId: "transfer-1",
      offsetBytes: 0,
      byteLength: 1_024,
      payloadEncoding: "binary",
    } as const;
    expect(v.safeParse(ContentChunkHeaderSchema, contentHeader).success).toBe(true);
    expect(
      v.safeParse(ContentChunkHeaderSchema, {
        kind: "content.chunk",
        transferId: "transfer-1",
        offsetBytes: 1_024,
        byteLength: 1_025,
        payloadEncoding: "binary",
      }).success,
    ).toBe(false);
    const dataFrame = v.parse(TransportFrameHeaderSchema, {
      lane: "data",
      epoch: "connection-1",
      streamId: 1,
      offsetBytes: 0,
      message: { ...contentHeader, byteLength: 128 },
    });
    const headerBytes = new TextEncoder().encode(JSON.stringify(dataFrame)).length;
    expect(readBinaryContent(dataFrame, new Uint8Array(128), headerBytes)?.payload.byteLength).toBe(
      128,
    );
    expect(readBinaryContent(dataFrame, new Uint8Array(129), headerBytes)).toBe(null);
    expect(readBinaryContent(dataFrame, new Uint8Array(128), 893)).toBe(null);
    expect(v.safeParse(ObjectChangeSchema, { kind: "object.patch" }).success).toBe(false);

    const cursor = v.parse(SyncCursorSchema, {
      environmentId: "environment-1",
      databaseGeneration: "database-1",
      visibilityGeneration: "grant-1",
      scope: { kind: "thread", threadId: "thread-1" },
      shapeVersion: 1,
      through: "41",
    });
    expect(
      readSubscriptionPage(
        {
          kind: "subscription.page",
          subscriptionId: "subscription-1",
          passId: "pass-1",
          through: { ...cursor, through: "42" },
          pageNumber: 0,
          pageCount: 1,
          changes: [{ kind: "object.patch" }],
        },
        cursor,
      ),
    ).toEqual({ kind: "gap", installed: cursor });
  });

  test("keeps each history page's own verified cursor", () => {
    const historyPage = v.parse(HistoryPageSchema, {
      kind: "history.page",
      threadId: "thread-1",
      anchor: "history-anchor-1",
      verifiedAt: {
        environmentId: "environment-1",
        databaseGeneration: "database-1",
        visibilityGeneration: "grant-1",
        scope: { kind: "thread", threadId: "thread-1" },
        shapeVersion: 1,
        through: "42",
      },
      pageNumber: 0,
      pageCount: 1,
      rows: [],
      olderAnchor: null,
    });

    expect(historyPage.verifiedAt.through.toString()).toBe("42");
  });

  test("accepts versioned tool activity in the strict history row union", () => {
    const item = {
      kind: "toolActivity",
      id: "tool-activity",
      threadId: "thread-1",
      source: {
        instanceId: "pi",
        nativeSessionId: "native-session",
        epoch: 1,
        eventId: "event-1",
        sourceId: "call-1",
        callId: "call-1",
      },
      assignment: { kind: "session" },
      phase: "started",
      inputSummary: "Read files.",
      outputSummary: null,
      createdAt: 12,
      createdPosition: "43",
      version: "1",
    };
    const row = { objectType: "timelineItem", value: item };
    expect(
      v.safeParse(HistoryPageSchema, {
        kind: "history.page",
        threadId: "thread-1",
        anchor: "history-anchor-1",
        verifiedAt: {
          environmentId: "environment-1",
          databaseGeneration: "database-1",
          visibilityGeneration: "grant-1",
          scope: { kind: "thread", threadId: "thread-1" },
          shapeVersion: 1,
          through: "44",
        },
        pageNumber: 0,
        pageCount: 1,
        rows: [row],
        olderAnchor: null,
      }).success,
    ).toBe(true);
    expect(
      v.safeParse(HistoryPageSchema, {
        kind: "history.page",
        threadId: "thread-1",
        anchor: "history-anchor-1",
        verifiedAt: {
          environmentId: "environment-1",
          databaseGeneration: "database-1",
          visibilityGeneration: "grant-1",
          scope: { kind: "thread", threadId: "thread-1" },
          shapeVersion: 1,
          through: "44",
        },
        pageNumber: 0,
        pageCount: 1,
        rows: [{ objectType: "timelineItem", value: { ...item, version: undefined } }],
        olderAnchor: null,
      }).success,
    ).toBe(false);
  });
});
