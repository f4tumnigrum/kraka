import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ContentTransferIdSchema,
  decodeFrame,
  encodeFrame,
  SubscriptionIdSchema,
  ToolActivityHistoryItemSchema,
  ToolActivityReferenceSchema,
  type ControlMessage,
  type TransportFrame,
  type ToolActivityBody,
  type ToolActivityHistoryItem,
} from "@kraka/protocol";
import { fixtureSession } from "../../../tools/fixtures/flow-session";
import { Journal } from "../../../tools/fixtures/route-network";
import { ThreadReplica, emptyThreadCache, type ToolActivityView } from "../src";

test("only complete authorized bodies install across split UTF-8, stale blocks and collapse", async () => {
  const f = fixtureSession("phone", "epoch", undefined, true);
  const epoch = f.hello.connectionId;
  const utf8 = {
    encode: (s: string) => new TextEncoder().encode(s),
    decode: (b: Uint8Array) => new TextDecoder("utf-8", { fatal: true }).decode(b),
  };
  const requests = new Journal<Extract<ControlMessage, { kind: "signedRequest" }>>();
  let cache = emptyThreadCache(),
    controlOffset = 0,
    offset = 0;
  const client = new ThreadReplica(
    f.hello,
    f.authorized,
    {
      utf8,
      now: () => performance.now(),
      write(w) {
        const frame = decodeFrame(w, utf8);
        if (frame.lane === "control" && frame.message.kind === "signedRequest")
          requests.push(frame.message);
        return 1;
      },
    },
    {
      read: () => cache,
      store: {
        async transact(edit) {
          const { next, result } = edit(cache);
          cache = next;
          return result;
        },
      },
      sign: f.request,
      id: () => v.parse(SubscriptionIdSchema, "viewer"),
    },
  );
  function control(message: ControlMessage) {
    const w = encodeFrame(
      { lane: "control", streamId: 0, epoch, offsetBytes: controlOffset, message },
      utf8,
    );
    controlOffset += typeof w === "string" ? utf8.encode(w).length : w.length;
    client.peer.input(w);
  }
  const data = (frame: Extract<TransportFrame, { lane: "data" }>) => {
    const w = encodeFrame(frame, utf8);
    offset += typeof w === "string" ? utf8.encode(w).length : w.length;
    client.peer.input(w);
  };
  control(f.authorized);
  control(f.configuration);
  await client.ready;
  const item = v.parse(ToolActivityHistoryItemSchema, {
    kind: "toolActivity",
    id: "i",
    threadId: "t",
    source: {
      instanceId: "exec",
      nativeSessionId: "session",
      epoch: 1,
      eventId: "a",
      sourceId: "src",
      callId: "native",
    },
    assignment: { kind: "session" },
    phase: "started",
    inputSummary: null,
    outputSummary: null,
    createdAt: 1,
    createdPosition: "1",
    version: "1",
  });
  const versions = new Journal<ToolActivityView>(),
    errors = new Journal<Error>();
  const open = client.readActivity({
    threadId: item.threadId,
    itemId: item.id,
    expectedVersion: null,
    onVersion: (v) => versions.push(v),
    onError: (e) => errors.push(e),
  });
  const req = await requests.until((r) => r.method === "tool.readActivity");
  if (req.method !== "tool.readActivity") throw Error("Expected tool read");
  const { streamId, subscriptionId } = req.payload;
  control({
    kind: "accepted",
    commandId: req.commandId,
    result: { kind: "activityReadStarted", streamId, subscriptionId },
  });
  const viewer = await open;
  if (viewer.kind !== "opened") throw Error("Expected viewer");
  function begin(row: ToolActivityHistoryItem) {
    const body: ToolActivityBody = {
      input: { kind: "unobserved" },
      output: { kind: "partial", text: "好\n", truncated: false },
      status: "running",
      exitCode: null,
      success: null,
      fileCoverage: "unknown",
      changes: [],
    };
    const bytes = utf8.encode(JSON.stringify({ item: row, body }));
    const reference = v.parse(ToolActivityReferenceSchema, {
      threadId: row.threadId,
      itemId: row.id,
      version: row.version,
      byteLength: bytes.length,
      sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
    });
    const transferId = v.parse(ContentTransferIdSchema, "transfer-" + row.version);
    data({
      lane: "data",
      epoch,
      streamId,
      offsetBytes: offset,
      message: { kind: "tool.activity.detail", reference, subscriptionId, transferId },
    });
    return {
      bytes,
      transferId,
      chunk(start: number, end: number, transfer = transferId) {
        const payload = bytes.slice(start, end);
        data({
          lane: "data",
          epoch,
          streamId,
          offsetBytes: offset,
          payload,
          message: {
            kind: "content.chunk",
            transferId: transfer,
            offsetBytes: start,
            byteLength: payload.length,
            payloadEncoding: "binary",
          },
        });
      },
    };
  }
  const one = begin(item);
  const split = one.bytes.indexOf(0xe5) + 1;
  expect(split).toBeGreaterThan(1);
  one.chunk(0, split);
  expect(versions.items).toHaveLength(0);
  one.chunk(split, one.bytes.length);
  expect((await versions.until(() => true)).body.output).toMatchObject({ text: "好\n" });
  const two = begin(
    v.parse(ToolActivityHistoryItemSchema, { ...item, version: "2", phase: "progress" }),
  );
  two.chunk(0, 5);
  two.chunk(5, two.bytes.length, one.transferId);
  expect(await errors.until(() => true)).toBeInstanceOf(Error);
  expect(client.cachedActivity(item.threadId, item.id)).toMatchObject({
    verified: false,
    view: { item: { version: "1" } },
  });
  expect(cache.scopes).toEqual({});
  await viewer.close();
  client.close();
});
