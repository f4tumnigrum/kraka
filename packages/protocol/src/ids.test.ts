import { describe, expect, test } from "bun:test";
import * as v from "valibot";
import {
  EnvironmentIdSchema,
  MessageSchema,
  NativeRootTurnIdSchema,
  ObjectVersionSchema,
  QueuePositionSchema,
  ProjectIdSchema,
  RoundIdSchema,
  SyncCursorSchema,
  ThreadLineageSchema,
  ThreadIdSchema,
  WorkRelationshipSchema,
} from "./index";
import type { NativeRootTurnId, ProjectId, RoundId, ThreadId } from "./index";

describe("branded object identifiers", () => {
  test("parses a canonical object version", () => {
    expect(String(v.parse(ObjectVersionSchema, "42"))).toBe("42");
    expect(String(v.parse(QueuePositionSchema, "42"))).toBe("42");
    expect(v.safeParse(ObjectVersionSchema, "042").success).toBe(false);
    expect(v.safeParse(QueuePositionSchema, "042").success).toBe(false);
    expect(v.safeParse(ObjectVersionSchema, "-1").success).toBe(false);
  });

  test("binds a sync cursor to environment, visibility, scope, shape and position", () => {
    const cursor = {
      environmentId: "environment-1",
      databaseGeneration: "database-3",
      visibilityGeneration: "grant-7",
      scope: { kind: "thread", threadId: "thread-1" },
      shapeVersion: 1,
      through: "42",
    };

    expect(v.parse(SyncCursorSchema, cursor).through.toString()).toBe("42");
    expect(v.safeParse(SyncCursorSchema, { ...cursor, through: "042" }).success).toBe(false);
    expect(v.safeParse(SyncCursorSchema, { ...cursor, unknownScope: true }).success).toBe(false);
  });

  test("rejects empty identifiers at the protocol boundary", () => {
    expect(v.safeParse(EnvironmentIdSchema, "").success).toBe(false);
    expect(v.safeParse(ThreadIdSchema, "thread-1").success).toBe(true);
  });

  test("keeps message references, attachments, and subjects explicit", () => {
    const parsed = v.parse(MessageSchema, {
      id: "message-1",
      threadId: "thread-1",
      roundId: null,
      author: { kind: "person", id: "principal-1" },
      text: "See the prior thread.",
      references: [{ kind: "thread", threadId: "thread-2" }],
      attachments: [{ kind: "image", id: "attachment-1", version: "3" }],
      version: "7",
    });

    expect(parsed.references).toHaveLength(1);
    expect(parsed.attachments[0]?.kind).toBe("image");
    expect(v.safeParse(MessageSchema, { ...parsed, unexpected: true }).success).toBe(false);
  });

  test("keeps child threads, forks, and executor handoffs as distinct relationships", () => {
    expect(
      v.parse(ThreadLineageSchema, { kind: "child", parentThreadId: "parent-thread" }).kind,
    ).toBe("child");
    expect(
      v.parse(WorkRelationshipSchema, {
        kind: "fork",
        parentThreadId: "parent-thread",
        sourceRoundId: "source-round",
        targetThreadId: "child-thread",
        sideChat: true,
      }).kind,
    ).toBe("fork");
    expect(
      v.parse(WorkRelationshipSchema, {
        kind: "providerHandoff",
        threadId: "thread-1",
        sourceSessionId: "native-session-1",
        targetSessionId: null,
        messageIds: ["message-1"],
      }).kind,
    ).toBe("providerHandoff");
  });

  test("does not allow different identifier brands to be assigned to each other", () => {
    const projectId: ProjectId = v.parse(ProjectIdSchema, "project-1");
    const roundId: RoundId = v.parse(RoundIdSchema, "round-1");
    const nativeRootTurnId: NativeRootTurnId = v.parse(NativeRootTurnIdSchema, "native-root-1");
    const threadId: ThreadId = v.parse(ThreadIdSchema, "thread-1");
    void projectId;
    void roundId;
    void nativeRootTurnId;
    void threadId;
    const version = v.parse(ObjectVersionSchema, "3");
    const queuePosition = v.parse(QueuePositionSchema, "4");
    void version;
    void queuePosition;

    // @ts-expect-error project identifiers cannot be used as thread identifiers
    const wrongThreadId: ThreadId = projectId;
    // @ts-expect-error native root turns cannot be used as kraka rounds
    const wrongRoundId: RoundId = nativeRootTurnId;
    // @ts-expect-error native root turns cannot be used as kraka thread identifiers
    const wrongNativeTurnId: NativeRootTurnId = threadId;
    // @ts-expect-error queue positions cannot be used as object versions
    const wrongVersion: v.InferOutput<typeof ObjectVersionSchema> = queuePosition;
    // @ts-expect-error object versions cannot be used as queue positions
    const wrongPosition: v.InferOutput<typeof QueuePositionSchema> = version;
    void wrongThreadId;
    void wrongRoundId;
    void wrongNativeTurnId;
    void wrongVersion;
    void wrongPosition;
  });
});
