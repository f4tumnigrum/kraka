import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  EnvironmentIdSchema,
  ThreadIdSchema,
  ThreadSchema,
  ObjectVersionSchema,
  TimelineItemIdSchema,
  type ThreadId,
} from "@kraka/protocol";
import { ThreadJournal } from "./thread-journal";
import { readActivity, type ToolActivityActor, type ToolActivityEvent } from "./tool-activity";

const environmentId = v.parse(EnvironmentIdSchema, "environment");
const actor = (canRead: (threadId: ThreadId) => boolean): ToolActivityActor => ({
  environmentId,
  visibility: "visible",
  timelineItems: true,
  protocolMinor: 1,
  allows: canRead,
});
const thread = (id: string) =>
  v.parse(ThreadSchema, {
    id,
    projectId: "project",
    worktreeId: null,
    title: id,
    lineage: { kind: "root" },
    version: "1",
  });
function store() {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE threads(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE messages(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE rounds(id TEXT PRIMARY KEY,data TEXT NOT NULL);",
  );
  const journal = new ThreadJournal(db, environmentId);
  const recordThread = (id: string) => {
    const value = thread(id);
    db.transaction(() => journal.record([{ objectType: "thread", value }]))();
    return value.id;
  };
  return { db, journal, recordThread };
}
function event(overrides: Partial<ToolActivityEvent> = {}): ToolActivityEvent {
  return {
    threadId: v.parse(ThreadIdSchema, "thread"),
    instanceId: "codex",
    nativeSessionId: "session",
    epoch: 1,
    eventId: "event-start",
    callId: "call",
    attemptId: "attempt-1",
    nativeRootTurnId: "root-1",
    phase: "started",
    inputJson: JSON.stringify({ command: "printf 'amber\\n'" }),
    outputText: null,
    exitCode: null,
    at: 100,
    ...overrides,
  };
}
function read(
  journal: ThreadJournal,
  threadId: ThreadId,
  itemId: string,
  expectedVersion: string | null = null,
) {
  return readActivity({
    actor: actor(() => true),
    journal,
    threadId,
    itemId: v.parse(TimelineItemIdSchema, itemId),
    expectedVersion: expectedVersion ? v.parse(ObjectVersionSchema, expectedVersion) : null,
  });
}

test("stores one stable call across progress, preserves exact bytes, and ignores stale finals", () => {
  const f = store(),
    threadId = f.recordThread("thread");
  const started = event();
  expect(f.journal.recordToolActivity(started)).toBe("stored");
  expect(f.journal.recordToolActivity({ ...started, at: 900 })).toBe("unchanged");

  let current = f.journal
    .read(
      {
        threadId,
        environmentId,
        canRead: () => true,
        timelineItems: true,
        protocolMinor: 1,
      },
      "visible",
    )
    .rows.find((row) => row.row.objectType === "timelineItem");
  if (!current || current.row.objectType !== "timelineItem") throw Error("Missing activity row");
  const itemId = current.row.value.id;
  expect(current.row.value.kind === "toolActivity" && current.row.value.phase).toBe("started");

  expect(
    f.journal.recordToolActivity(
      event({
        eventId: "event-high-surrogate",
        phase: "progress",
        inputJson: null,
        outputText: "\ud83d",
      }),
    ),
  ).toBe("stored");
  const lowSurrogate = event({
    eventId: "event-low-surrogate",
    phase: "progress",
    inputJson: null,
    outputText: "\ude00",
  });
  expect(f.journal.recordToolActivity(lowSurrogate)).toBe("stored");
  expect(f.journal.recordToolActivity({ ...lowSurrogate, at: 901 })).toBe("unchanged");
  expect(
    f.journal.recordToolActivity(
      event({
        eventId: "event-end",
        phase: "ended",
        inputJson: null,
        outputText: "😀\n",
        exitCode: 0,
      }),
    ),
  ).toBe("stored");

  const ended = f.journal.toolActivityVersion(threadId, itemId, "4");
  expect(ended?.body).toEqual({
    input: { kind: "captured", json: JSON.stringify({ command: "printf 'amber\\n'" }) },
    output: { kind: "complete", text: "😀\n" },
    status: "completed",
    exitCode: 0,
    success: true,
    changes: [],
  });
  const stale = event({
    eventId: "stale-end",
    phase: "ended",
    inputJson: null,
    outputText: "old output",
    exitCode: 1,
  });
  expect(f.journal.recordToolActivity(stale)).toBe("unchanged");
  expect(f.journal.toolActivityVersion(threadId, itemId, "4")?.body.output).toEqual({
    kind: "complete",
    text: "😀\n",
  });
  expect(f.journal.recordToolActivity({ ...stale, outputText: "conflict" })).toBe("conflict");

  current = f.journal
    .read(
      {
        threadId,
        environmentId,
        canRead: () => true,
        timelineItems: true,
        protocolMinor: 1,
      },
      "visible",
    )
    .rows.find((row) => row.row.objectType === "timelineItem");
  expect(String(current?.row.value.version)).toBe("4");
  f.db.close();
});

test("isolates reused native IDs by thread and attempt, and does not assign free file evidence", () => {
  const f = store(),
    firstThread = f.recordThread("thread-a"),
    secondThread = f.recordThread("thread-b");
  f.journal.recordToolActivity(event({ threadId: firstThread, callId: "reused" }));
  f.journal.recordToolActivity(
    event({
      threadId: firstThread,
      eventId: "event-attempt-2",
      callId: "reused",
      attemptId: "attempt-2",
      nativeRootTurnId: "root-2",
    }),
  );
  f.journal.recordToolActivity(event({ threadId: secondThread, callId: "reused" }));
  const ids = f.db
    .query<{ item_id: string }, []>("SELECT item_id FROM tool_activity_sources ORDER BY rowid")
    .all()
    .map((row) => row.item_id);
  expect(new Set(ids).size).toBe(3);

  f.journal.recordUnattributedToolChange({
    threadId: firstThread,
    attemptId: "attempt-2",
    eventId: "file-change",
    path: "result.txt",
    change: "modified",
    destination: null,
    patch: "+line",
  });
  const detail = f.journal.toolActivityVersion(
    firstThread,
    v.parse(TimelineItemIdSchema, ids[1]),
    "1",
  );
  expect(detail?.body.changes).toEqual([]);
  expect(
    f.db.query("SELECT data FROM tool_activity_scoped_changes WHERE thread_id=?").all(firstThread),
  ).toHaveLength(1);
  f.db.close();
});

test("opens exact old versions, returns a replacement for an expired version, and rechecks source access", () => {
  const f = store(),
    threadId = f.recordThread("thread");
  f.journal.recordToolActivity(event());
  f.journal.recordToolActivity(
    event({ eventId: "event-progress", phase: "progress", inputJson: null, outputText: "kept" }),
  );
  const rows = f.journal.read(
    {
      threadId,
      environmentId,
      canRead: () => true,
      timelineItems: true,
      protocolMinor: 1,
    },
    "visible",
  ).rows;
  const activity = rows.find((row) => row.row.objectType === "timelineItem");
  if (!activity || activity.row.objectType !== "timelineItem") throw Error("Missing activity row");

  expect(read(f.journal, threadId, activity.row.value.id, "1")).toMatchObject({
    kind: "ready",
    version: { item: { version: "1", phase: "started" } },
  });
  f.db.run("DELETE FROM tool_activity_versions WHERE thread_id=? AND item_id=? AND version=?", [
    threadId,
    activity.row.value.id,
    "1",
  ]);
  expect(read(f.journal, threadId, activity.row.value.id, "1")).toMatchObject({
    kind: "expired",
    replacement: { version: "2" },
  });
  expect(
    readActivity({
      actor: actor((source) => source === threadId),
      journal: f.journal,
      threadId,
      itemId: activity.row.value.id,
      expectedVersion: null,
    }).kind,
  ).toBe("ready");
  expect(
    readActivity({
      actor: actor(() => false),
      journal: f.journal,
      threadId,
      itemId: activity.row.value.id,
      expectedVersion: null,
    }),
  ).toEqual({ kind: "notFound" });
  f.db.close();
});
