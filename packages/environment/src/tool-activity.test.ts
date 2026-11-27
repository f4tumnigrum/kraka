import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  EnvironmentIdSchema,
  ThreadIdSchema,
  AttemptIdSchema,
  RoundIdSchema,
  NativeSessionIdSchema,
  NativeRootTurnIdSchema,
  ExecutorInstanceIdSchema,
  NativeItemIdSchema,
  ThreadSchema,
  ObjectVersionSchema,
  TimelineItemIdSchema,
  type ThreadId,
} from "@kraka/protocol";
import { ThreadJournal } from "./thread-journal";
import {
  recordAdapterActivity,
  evolveToolActivity,
  readActivity,
  type ToolActivityActor,
  type ToolActivityEvent,
} from "./tool-activity";

const environmentId = v.parse(EnvironmentIdSchema, "environment");
const actor = (canRead: (threadId: ThreadId) => boolean): ToolActivityActor => ({
  environmentId,
  visibility: "visible",
  timelineItems: true,
  protocolMinor: 2,
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

function stored(journal: ThreadJournal, ...args: Parameters<ThreadJournal["activityTransfer"]>) {
  const version = journal.activityTransfer(...args);
  return version && { ...version, body: journal.activityBody(version) };
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
        protocolMinor: 2,
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

  const ended = stored(f.journal, threadId, itemId, "4");
  expect(ended?.body).toEqual({
    input: { kind: "captured", json: JSON.stringify({ command: "printf 'amber\\n'" }) },
    output: { kind: "complete", text: "😀\n" },
    status: "completed",
    exitCode: 0,
    success: true,
    fileCoverage: "unknown",
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
  expect(stored(f.journal, threadId, itemId, "4")?.body.output).toEqual({
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
        protocolMinor: 2,
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
      eventId: "event-start",
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
  const detail = stored(f.journal, firstThread, v.parse(TimelineItemIdSchema, ids[1]), "1");
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
      protocolMinor: 2,
    },
    "visible",
  ).rows;
  const activity = rows.find((row) => row.row.objectType === "timelineItem");
  if (!activity || activity.row.objectType !== "timelineItem") throw Error("Missing activity row");

  expect(read(f.journal, threadId, activity.row.value.id, "1")).toMatchObject({
    kind: "ready",
    version: { item: { version: "1", phase: "started" } },
  });
  f.db.run(
    "DELETE FROM tool_activity_versions WHERE source=(SELECT id FROM tool_activity_sources WHERE thread_id=? AND item_id=?) AND version=?",
    [threadId, activity.row.value.id, "1"],
  );
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

test("a failed body commit rolls back its blocks, event and summary and permits retry", () => {
  const f = store();
  try {
    const threadId = f.recordThread("thread");
    f.journal.recordToolActivity(event());
    const prior = f.db
      .query<{ item_id: string }, []>("SELECT item_id FROM tool_activity_sources")
      .get();
    const id = v.parse(TimelineItemIdSchema, prior?.item_id);
    const count = () =>
      f.db.query<{ n: number }, []>("SELECT COUNT(*) n FROM tool_activity_parts").get()?.n;
    const blocks = count();
    f.db.exec(
      "CREATE TEMP TRIGGER reject_version BEFORE INSERT ON tool_activity_versions BEGIN SELECT RAISE(ABORT,'interrupted'); END",
    );
    const end = event({ eventId: "end", phase: "ended", outputText: "", exitCode: null });
    expect(() => f.journal.recordToolActivity(end)).toThrow("interrupted");
    expect(count()).toBe(blocks);
    expect(read(f.journal, threadId, id)).toMatchObject({
      current: { version: "1", phase: "started" },
    });
    f.db.exec("DROP TRIGGER reject_version");
    expect(f.journal.recordToolActivity(end)).toBe("stored");
    expect(stored(f.journal, threadId, id, "2")?.body).toMatchObject({
      output: { kind: "complete", text: "" },
      status: "unknown",
      exitCode: null,
    });
  } finally {
    f.db.close();
  }
});

test("session evidence promotes in place and a parent end cannot invent the tool exit", () => {
  const f = store();
  try {
    const threadId = f.recordThread("thread"),
      attemptId = v.parse(AttemptIdSchema, "attempt"),
      roundId = v.parse(RoundIdSchema, "round"),
      sessionId = v.parse(NativeSessionIdSchema, "native"),
      root = v.parse(NativeRootTurnIdSchema, "root");
    const binding = {
      threadId,
      attemptId,
      nativeSessionId: sessionId,
      instanceId: v.parse(ExecutorInstanceIdSchema, "instance"),
      family: "codex" as const,
      epoch: 1,
    };
    const envelope = {
      instanceId: binding.instanceId,
      family: binding.family,
      epoch: 1,
      sessionId,
    };
    const observation = {
      ...envelope,
      eventId: "obs",
      payload: {
        kind: "sessionObservation" as const,
        sourceId: "native-observation",
        category: "toolActivity" as const,
        redactedSummary: "read",
        observedAt: 1,
      },
    };
    recordAdapterActivity(f.journal, binding, roundId, observation, null);
    recordAdapterActivity(f.journal, binding, roundId, observation, null);
    const rows = () =>
      f.journal
        .read(
          { threadId, environmentId, canRead: () => true, timelineItems: true, protocolMinor: 2 },
          "visibility",
        )
        .rows.flatMap((r) => (r.row.objectType === "timelineItem" ? [r.row.value] : []));
    const prior = rows()[0]!;
    expect(rows()).toHaveLength(1);
    expect(prior.assignment).toEqual({ kind: "session" });
    const tool = {
      ...envelope,
      eventId: "start",
      payload: {
        kind: "toolActivity" as const,
        callId: v.parse(NativeItemIdSchema, "call"),
        attemptId,
        phase: "started" as const,
        input: { command: "test" },
        output: null,
        relationship: { kind: "root" as const, nativeRootTurnId: root },
        observation: { sourceId: "native-observation", eventId: "obs" },
      },
    };
    expect(() =>
      recordAdapterActivity(f.journal, binding, roundId, { ...tool, epoch: 2 }, root),
    ).toThrow("Foreign");
    recordAdapterActivity(f.journal, binding, roundId, tool, root);
    expect(
      recordAdapterActivity(
        f.journal,
        binding,
        roundId,
        {
          ...tool,
          payload: { ...tool.payload, observation: { sourceId: "wrong", eventId: "other" } },
        },
        root,
      ),
    ).toBe("conflict");
    expect(rows().find((r) => r.kind === "executorObservation")).toMatchObject({
      id: prior.id,
      createdPosition: prior.createdPosition,
      assignment: { kind: "attempt", attemptId },
      version: "2",
    });
    recordAdapterActivity(
      f.journal,
      binding,
      roundId,
      {
        ...envelope,
        eventId: "parent-end",
        payload: {
          kind: "roundEnded",
          attemptId,
          nativeRootTurnId: root,
          endedAt: 10,
          endTimeEvidence: {
            source: "executorReported",
            executorEndedAt: 10,
            environmentObservedAt: null,
          },
          outcome: { reason: "completed", nativeReason: null },
        },
      },
      root,
    );
    const active = rows().find((r) => r.kind === "toolActivity")!;
    expect(stored(f.journal, threadId, active.id, "1")?.body).toMatchObject({
      status: "running",
      exitCode: null,
      output: { kind: "unobserved" },
    });
  } finally {
    f.db.close();
  }
});

test("reopens the previous storage format with identical wire bytes, versions and event receipts", () => {
  const f = store();
  try {
    const threadId = f.recordThread("thread");
    const input = event();
    const text = "古い記録\n".repeat(900);
    const end = event({
      phase: "ended",
      eventId: "end",
      inputJson: null,
      outputText: text,
      exitCode: 7,
    });
    const id = v.parse(TimelineItemIdSchema, "retained-call");
    const first = evolveToolActivity(null, input, { id, createdPosition: "2" });
    const last = evolveToolActivity(first, end, { id, createdPosition: "2" });
    f.db.exec(`DROP TABLE tool_activity_parts; DROP TABLE tool_activity_versions; DROP TABLE tool_activity_events; DROP TABLE tool_activity_sources;
      CREATE TABLE tool_activity_sources(thread_id TEXT,instance_id TEXT,session_id TEXT,epoch INTEGER,call_id TEXT,attempt_id TEXT,item_id TEXT);
      CREATE TABLE tool_activity_versions(thread_id TEXT,item_id TEXT,version TEXT,summary TEXT,byte_length INTEGER,sha256 TEXT,PRIMARY KEY(thread_id,item_id,version));
      CREATE TABLE tool_activity_blocks(digest TEXT,part INTEGER,data BLOB,PRIMARY KEY(digest,part));
      CREATE TABLE tool_activity_events(thread_id TEXT,instance_id TEXT,session_id TEXT,epoch INTEGER,attempt_id TEXT,event_id TEXT,payload TEXT);`);
    const versions = [first, last].map(({ item, body }) => {
      const bytes = Buffer.from(JSON.stringify({ item, body }));
      const hash = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
      for (let i = 0; i < bytes.length; i += 4096)
        f.db.run("INSERT INTO tool_activity_blocks VALUES(?,?,?)", [
          hash,
          i / 4096,
          bytes.subarray(i, i + 4096),
        ]);
      f.db.run("INSERT INTO tool_activity_versions VALUES(?,?,?,?,?,?)", [
        threadId,
        id,
        item.version,
        JSON.stringify(item),
        bytes.length,
        hash,
      ]);
      return { item, bytes, hash };
    });
    for (const e of [input, end]) {
      const { at: _at, ...fact } = e;
      f.db.run("INSERT INTO tool_activity_events VALUES(?,?,?,?,?,?,?)", [
        threadId,
        e.instanceId,
        e.nativeSessionId,
        e.epoch,
        e.attemptId,
        e.eventId,
        new Bun.CryptoHasher("sha256").update(JSON.stringify(fact)).digest("hex"),
      ]);
    }
    f.db.run("INSERT INTO tool_activity_sources VALUES(?,?,?,?,?,?,?)", [
      threadId,
      input.instanceId,
      input.nativeSessionId,
      input.epoch,
      input.callId,
      input.attemptId,
      id,
    ]);
    f.db.transaction(() => f.journal.record([{ objectType: "timelineItem", value: last.item }]))();
    f.db.run("UPDATE tool_activity_versions SET byte_length=byte_length-1 WHERE version='2'");
    expect(() => new ThreadJournal(f.db, environmentId)).toThrow("Incomplete legacy activity body");
    expect(f.db.query("SELECT 1 FROM tool_activity_blocks LIMIT 1").get()).toBeTruthy();
    f.db.run("UPDATE tool_activity_versions SET byte_length=byte_length+1 WHERE version='2'");
    const reopened = new ThreadJournal(f.db, environmentId);
    for (const { item, bytes, hash } of versions) {
      const opened = read(reopened, threadId, id, item.version);
      if (opened.kind !== "ready") throw Error("Missing migrated version");
      expect(opened.version.reference).toMatchObject({ sha256: hash, byteLength: bytes.length });
      expect(opened.version.item).toEqual(item);
      // Read backwards across storage and UTF-8 boundaries using independent byte ranges.
      const restored = Buffer.alloc(bytes.length);
      for (let end = bytes.length; end > 0; ) {
        const start = Math.max(0, end - 389);
        restored.set(opened.version.read(start, end - start), start);
        end = start;
      }
      expect(restored.equals(bytes)).toBe(true);
    }
    expect(reopened.recordToolActivity(end)).toBe("unchanged");
    expect(reopened.recordToolActivity({ ...end, outputText: "other" })).toBe("conflict");
  } finally {
    f.db.close(true);
  }
});
