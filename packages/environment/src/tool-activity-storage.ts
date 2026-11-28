import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import * as v from "valibot";
import {
  ToolActivityContentSchema,
  ToolActivityHistoryItemSchema,
  ToolActivityReferenceSchema,
  keyString,
  rowKey,
  type ThreadId,
  type TimelineItemId,
  type ToolActivityBody,
  type ToolActivityHistoryItem,
} from "@kraka/protocol";
import type { StoredToolActivityVersion, ToolActivityEvent } from "./tool-activity";

const blockSize = 4096;
const manifestSchema = v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1)));
const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();
const prefix = (item: ToolActivityHistoryItem) =>
  Buffer.from(`{"item":${JSON.stringify(item)},"body":`);
const suffix = Buffer.from("}");

type SourceEvent = Pick<
  ToolActivityEvent,
  "threadId" | "instanceId" | "nativeSessionId" | "epoch" | "attemptId" | "eventId"
>;
function sourceKey(event: SourceEvent) {
  return sha(
    JSON.stringify([
      event.threadId,
      event.instanceId,
      event.nativeSessionId,
      event.epoch,
      event.attemptId,
      event.eventId,
    ]),
  );
}

type SummaryParts = {
  identity: Uint8Array;
  preview: Uint8Array;
  thread_id: string;
  item_id: string;
  instance_id: string;
  session_id: string;
  epoch: number;
  call_id: string;
  attempt_id: string;
};
const fields =
  "s.thread_id,s.item_id,s.instance_id,s.session_id,s.epoch,s.call_id,s.attempt_id,i.bytes identity,p.bytes preview";
const joins = `FROM tool_activity_sources s
  JOIN tool_activity_versions v ON v.source=s.id
  JOIN tool_activity_parts i ON i.id=v.identity_id
  JOIN tool_activity_parts p ON p.id=v.preview_id
  WHERE s.thread_id=? AND s.item_id=? AND v.version=?`;
function summaryFrom(row: SummaryParts, version: string) {
  const identity = JSON.parse(Buffer.from(row.identity).toString("utf8"));
  return v.parse(ToolActivityHistoryItemSchema, {
    kind: "toolActivity",
    threadId: row.thread_id,
    id: row.item_id,
    version,
    source: {
      instanceId: row.instance_id,
      nativeSessionId: row.session_id,
      epoch: row.epoch,
      callId: row.call_id,
      sourceId: identity.sourceId,
      eventId: identity.eventId,
    },
    assignment: identity.relationship
      ? { kind: "attempt", attemptId: row.attempt_id, relationship: identity.relationship }
      : { kind: "session" },
    createdPosition: identity.createdPosition,
    createdAt: identity.createdAt,
    ...JSON.parse(Buffer.from(row.preview).toString("utf8")),
  });
}

export class ToolActivityStorage {
  private constructor(private db: Database) {}
  static open(db: Database) {
    if (!db.inTransaction)
      throw Error("Activity storage must initialize inside the journal transaction");
    const legacy = db
      .query("SELECT 1 FROM pragma_table_info('tool_activity_versions') WHERE name='summary'")
      .get();
    if (legacy)
      db.exec(`
      ALTER TABLE tool_activity_versions RENAME TO old_activity_versions;
      ALTER TABLE tool_activity_events RENAME TO old_activity_events;
      ALTER TABLE tool_activity_sources RENAME TO old_activity_sources;
    `);
    db.exec(`CREATE TABLE IF NOT EXISTS tool_activity_sources(
        id INTEGER PRIMARY KEY,thread_id TEXT NOT NULL,instance_id TEXT NOT NULL,session_id TEXT NOT NULL,
        epoch INTEGER NOT NULL,call_id TEXT NOT NULL,attempt_id TEXT NOT NULL,item_id TEXT NOT NULL,
        UNIQUE(thread_id,item_id),UNIQUE(thread_id,instance_id,session_id,epoch,call_id,attempt_id));
      CREATE TABLE IF NOT EXISTS tool_activity_parts(
      id INTEGER PRIMARY KEY, digest BLOB NOT NULL UNIQUE, bytes BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_activity_versions(
        source INTEGER NOT NULL,version TEXT NOT NULL,
        identity_id INTEGER NOT NULL,preview_id INTEGER NOT NULL,body_parts TEXT NOT NULL,
        body_size INTEGER NOT NULL,wire_digest BLOB NOT NULL,PRIMARY KEY(source,version)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS tool_activity_events(
        source_key BLOB PRIMARY KEY,payload_digest BLOB NOT NULL) WITHOUT ROWID;`);
    const storage = new ToolActivityStorage(db);
    if (legacy) storage.migrate();
    return storage;
  }
  private part(bytes: Uint8Array): number {
    const digest = sha(bytes);
    const existing = this.db
      .query<{ id: number }, [Uint8Array]>("SELECT id FROM tool_activity_parts WHERE digest=?")
      .get(digest);
    if (existing) return existing.id;
    return Number(
      this.db.run("INSERT INTO tool_activity_parts(digest,bytes) VALUES(?,?)", [digest, bytes])
        .lastInsertRowid,
    );
  }
  recordEvent(event: ToolActivityEvent): "new" | "unchanged" | "conflict" {
    const { at: _at, ...fact } = event;
    const key = sourceKey(event),
      digest = sha(JSON.stringify(fact));
    const previous = this.db
      .query<{ payload_digest: Uint8Array }, [Uint8Array]>(
        "SELECT payload_digest FROM tool_activity_events WHERE source_key=?",
      )
      .get(key);
    if (previous) return digest.equals(previous.payload_digest) ? "unchanged" : "conflict";
    this.db.run("INSERT INTO tool_activity_events VALUES(?,?)", [key, digest]);
    return "new";
  }
  save(call: number, item: ToolActivityHistoryItem, body: ToolActivityBody) {
    const { phase, inputSummary, outputSummary, version } = item;
    const identity = {
      sourceId: item.source.sourceId,
      eventId: item.source.eventId,
      createdPosition: item.createdPosition,
      createdAt: item.createdAt,
      relationship: item.assignment.kind === "attempt" ? item.assignment.relationship : null,
    };
    const identityId = this.part(Buffer.from(JSON.stringify(identity)));
    const previewId = this.part(
      Buffer.from(JSON.stringify({ phase, inputSummary, outputSummary })),
    );
    const bytes = Buffer.from(JSON.stringify(body));
    const ids: number[] = [];
    for (let start = 0; start < bytes.length; start += blockSize)
      ids.push(this.part(bytes.subarray(start, start + blockSize)));
    const digest = createHash("sha256").update(prefix(item)).update(bytes).update(suffix).digest();
    this.db.run("INSERT INTO tool_activity_versions VALUES(?,?,?,?,?,?,?)", [
      call,
      version,
      identityId,
      previewId,
      JSON.stringify(ids),
      bytes.length,
      digest,
    ]);
    return digest;
  }
  summary(threadId: ThreadId, itemId: string, version: string) {
    const row = this.db
      .query<SummaryParts, [string, string, string]>(`SELECT ${fields} ${joins}`)
      .get(threadId, itemId, version);
    if (!row) throw Error("Missing committed activity summary");
    return summaryFrom(row, version);
  }
  transfer(
    threadId: ThreadId,
    itemId: TimelineItemId,
    version: string,
  ): StoredToolActivityVersion | null {
    const row = this.db
      .query<
        SummaryParts & { body_parts: string; body_size: number; wire_digest: Uint8Array },
        [string, string, string]
      >(`SELECT ${fields},v.body_parts,v.body_size,v.wire_digest ${joins}`)
      .get(threadId, itemId, version);
    if (!row) return null;
    const item = summaryFrom(row, version),
      head = prefix(item),
      ids = v.parse(manifestSchema, JSON.parse(row.body_parts));
    const reference = v.parse(ToolActivityReferenceSchema, {
      threadId,
      itemId,
      version,
      byteLength: head.length + row.body_size + suffix.length,
      sha256: Buffer.from(row.wire_digest).toString("hex"),
    });
    if (ids.length !== Math.ceil(row.body_size / blockSize))
      throw Error("Incomplete activity body");
    const get = this.db.query<{ bytes: Uint8Array }, [number]>(
      "SELECT bytes FROM tool_activity_parts WHERE id=?",
    );
    let loaded: number | undefined,
      block: Uint8Array = new Uint8Array(0);
    return {
      item,
      reference,
      read(start, length) {
        if (start < 0 || length < 0 || start + length > reference.byteLength)
          throw Error("Invalid activity body range");
        const result = new Uint8Array(length);
        for (let written = 0; written < length; ) {
          const offset = start + written,
            bodyOffset = offset - head.length;
          let bytes: Uint8Array;
          if (bodyOffset < 0) bytes = head.subarray(offset);
          else if (bodyOffset === row.body_size) bytes = suffix;
          else {
            const id = ids[Math.floor(bodyOffset / blockSize)];
            if (id === undefined) throw Error("Invalid activity block");
            if (loaded !== id) {
              const part = get.get(id);
              if (!part) throw Error("Missing activity body block");
              block = part.bytes;
              loaded = id;
            }
            bytes = block.subarray(bodyOffset % blockSize);
          }
          const take = bytes.subarray(0, length - written);
          if (!take.length) throw Error("Short activity body");
          result.set(take, written);
          written += take.length;
        }
        return result;
      },
    };
  }
  private migrate() {
    const db = this.db;
    db.exec(`INSERT INTO tool_activity_sources(thread_id,instance_id,session_id,epoch,call_id,attempt_id,item_id)
      SELECT thread_id,instance_id,session_id,epoch,call_id,attempt_id,item_id FROM old_activity_sources`);
    for (const row of db
      .query<{ call: number | null; sha256: string; byte_length: number }, []>(
        "SELECT s.id AS call,v.sha256,v.byte_length FROM old_activity_versions v LEFT JOIN tool_activity_sources s ON s.thread_id=v.thread_id AND s.item_id=v.item_id",
      )
      .iterate()) {
      if (row.call === null) throw Error("Missing legacy activity source");
      const chunks = db
        .query<{ data: Uint8Array }, [string]>(
          "SELECT data FROM tool_activity_blocks WHERE digest=? ORDER BY part",
        )
        .all(row.sha256);
      const bytes = Buffer.concat(chunks.map((c) => c.data));
      if (bytes.length !== row.byte_length) throw Error("Incomplete legacy activity body");
      const { item, body } = v.parse(ToolActivityContentSchema, JSON.parse(bytes.toString("utf8")));
      if (this.save(row.call, item, body).toString("hex") !== row.sha256)
        throw Error("Legacy activity digest mismatch");
      const old = { objectType: "timelineItem" as const, value: item };
      db.run(
        "UPDATE sync_rows SET payload=? WHERE source=? AND key=? AND version=? AND payload=?",
        [
          JSON.stringify(item.id),
          item.threadId,
          keyString(rowKey(old)),
          item.version,
          JSON.stringify(old),
        ],
      );
    }
    for (const e of db
      .query<SourceEvent & { payload: string }, []>(
        `SELECT thread_id threadId,instance_id instanceId,session_id nativeSessionId,epoch,attempt_id attemptId,event_id eventId,payload FROM old_activity_events`,
      )
      .iterate()) {
      db.run("INSERT INTO tool_activity_events VALUES(?,?)", [
        sourceKey(e),
        Buffer.from(e.payload, "hex"),
      ]);
    }
    db.exec(
      "DROP TABLE old_activity_versions; DROP TABLE old_activity_events; DROP TABLE old_activity_sources; DROP TABLE tool_activity_blocks;",
    );
  }
}
