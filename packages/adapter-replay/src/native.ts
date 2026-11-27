import * as v from "valibot";
import {
  NativeItemIdSchema,
  NativeRootTurnIdSchema,
  NativeSessionIdSchema,
  type NativeItemId,
  type NativeRootTurnId,
  type NativeSessionId,
} from "@kraka/protocol";
import { parseExecutorSample } from "./recording";

type NativeUpdate =
  | { kind: "internal" }
  | { kind: "start"; root: NativeRootTurnId; at: number }
  | { kind: "toolStart"; id: NativeItemId; command: string }
  | { kind: "toolDelta"; id: NativeItemId; text: string }
  | { kind: "toolEnd"; id: NativeItemId; text: string; exitCode: number }
  | { kind: "delta" | "final"; id: NativeItemId; text: string }
  | { kind: "end"; root: NativeRootTurnId; at: number };
export type ReplayFrame = Readonly<NativeUpdate & { requestId: string }>;
export type ReplayRecording = {
  readonly frames: readonly ReplayFrame[];
  readonly expectedText: string;
  readonly modelId: string;
  readonly nativeSessionId: NativeSessionId;
  readonly nativeRootTurnId: NativeRootTurnId;
  readonly startedAt: number;
  readonly endedAt: number;
};

const text = v.pipe(v.string(), v.minLength(1));
const millis = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const seconds = v.pipe(
  v.number(),
  v.transform((s) => s * 1000),
  v.safeInteger(),
  v.minValue(0),
);
const rpcId = v.union([text, v.pipe(v.number(), v.safeInteger())]);
const absent = v.optional(v.never());
const request = <S extends v.GenericSchema>(method: string, params: S) =>
  v.object({ id: rpcId, method: v.literal(method), params, result: absent, error: absent });
const response = <S extends v.GenericSchema>(id: string | number, result: S) =>
  v.object({ id: v.literal(id), result, method: absent, params: absent, error: absent });
const notice = <S extends v.GenericSchema>(method: string, params: S) =>
  v.object({ id: absent, result: absent, error: absent, method: v.literal(method), params });
const thread = v.object({
  id: NativeSessionIdSchema,
  sessionId: NativeSessionIdSchema,
  parentThreadId: v.null(),
});
const turnIds = { id: NativeRootTurnIdSchema, rootTurnId: NativeRootTurnIdSchema };
const running = {
  ...turnIds,
  status: v.literal("inProgress"),
  error: v.null(),
  completedAt: v.null(),
};
const input = v.strictTuple([v.object({ type: v.literal("text"), text })]);

export function parseReplayRecording(source: string): ReplayRecording {
  const { header, frames } = parseExecutorSample(source);
  if (
    header.family !== "codex" ||
    header.protocol !== "Codex app-server v2 JSON-RPC" ||
    header.scenario !== "basic-turn" ||
    !header.sourceRevision.trim()
  )
    throw new Error("Expected a Codex basic-turn header at line 1");

  let seq = 0;
  function check(ok: boolean, field: string) {
    if (!ok) throw new Error(`Invalid ${field} at line ${seq + 1}`);
  }
  function read<S extends v.GenericSchema>(schema: S): v.InferOutput<S> {
    const row = frames[seq++];
    if (!row) throw new Error(`Expected frame ${seq} at EOF at line ${seq + 1}`);
    check(
      row.channel === "stdio" &&
        row.direction === ([1, 3, 4, 7].includes(seq) ? "toExecutor" : "fromExecutor"),
      "transport",
    );
    const res = v.safeParse(schema, row.frame);
    if (!res.success)
      throw new Error(
        `Invalid frame at line ${seq + 1}: ${v.getDotPath(res.issues[0]) ?? "frame"}`,
      );
    return res.output;
  }
  const init = read(
    request("initialize", v.object({ clientInfo: v.object({ name: text, version: text }) })),
  );
  read(response(init.id, v.object({ userAgent: text })));
  read(notice("initialized", absent));
  const open = read(request("thread/start", v.object({ model: text })));
  const modelId = open.params.model;
  const opened = read(response(open.id, v.object({ thread }))).result.thread;
  const nativeSessionId = opened.id;
  check(opened.sessionId === nativeSessionId, "thread session");
  const observed = read(notice("thread/started", v.object({ thread }))).params.thread;
  check(
    observed.id === nativeSessionId && observed.sessionId === nativeSessionId,
    "thread session",
  );
  const threadId = v.literal(nativeSessionId);
  const submitted = read(request("turn/start", v.object({ threadId, input })));
  const requestId = String(submitted.id);
  const expectedText = submitted.params.input[0].text;
  const written = read(
    response(submitted.id, v.object({ turn: v.object({ ...running, startedAt: v.null() }) })),
  ).result.turn;
  const nativeRootTurnId = written.rootTurnId;
  check(written.id === nativeRootTurnId, "root turn");
  const ids = { id: v.literal(nativeRootTurnId), rootTurnId: v.literal(nativeRootTurnId) };
  const started = read(
    notice(
      "turn/started",
      v.object({ threadId, turn: v.object({ ...running, ...ids, startedAt: seconds }) }),
    ),
  ).params.turn;
  const startedAt = started.startedAt;
  const address = { threadId, turnId: v.literal(nativeRootTurnId) };
  const startItem = <const E extends v.ObjectEntries>(entries: E) => {
    const p = read(
      notice(
        "item/started",
        v.object({
          ...address,
          item: v.object({ ...entries, startedAtMs: millis }),
          startedAtMs: millis,
        }),
      ),
    ).params;
    check(p.startedAtMs === p.item.startedAtMs, "item start time");
    return { item: p.item, at: p.startedAtMs };
  };
  const endItem = <const E extends v.ObjectEntries>(entries: E, at: number) => {
    const p = read(
      notice(
        "item/completed",
        v.object({
          ...address,
          item: v.object({ ...entries, startedAtMs: v.literal(at), completedAtMs: millis }),
          completedAtMs: millis,
        }),
      ),
    ).params;
    check(p.completedAtMs === p.item.completedAtMs && p.completedAtMs >= at, "item end time");
    return p.item;
  };
  const userItem = {
    type: v.literal("userMessage"),
    id: NativeItemIdSchema,
    clientId: v.null(),
    content: v.strictTuple([v.object({ type: v.literal("text"), text: v.literal(expectedText) })]),
  };
  const user = startItem(userItem);
  endItem({ ...userItem, id: v.literal(user.item.id) }, user.at);
  const tool = startItem({
    type: v.literal("commandExecution"),
    id: NativeItemIdSchema,
    command: text,
    status: v.literal("inProgress"),
    aggregatedOutput: v.null(),
    exitCode: v.null(),
  });
  const call = tool.item;
  const delta = (method: string, id: NativeItemId) =>
    read(notice(method, v.object({ ...address, itemId: v.literal(id), delta: text }))).params.delta;
  const output = delta("item/commandExecution/outputDelta", call.id);
  const toolEnd = endItem(
    {
      type: v.literal("commandExecution"),
      id: v.literal(call.id),
      command: v.literal(call.command),
      status: v.literal("completed"),
      aggregatedOutput: v.literal(output),
      exitCode: v.pipe(v.number(), v.integer()),
    },
    tool.at,
  );
  const assistant = startItem({
    type: v.literal("agentMessage"),
    id: NativeItemIdSchema,
    text: v.literal(""),
  });
  const item = assistant.item.id;
  const first = delta("item/agentMessage/delta", item);
  const second = delta("item/agentMessage/delta", item);
  const finalItem = v.object({
    type: v.literal("agentMessage"),
    id: v.literal(item),
    text: v.literal(first + second),
  });
  const final = endItem(finalItem.entries, assistant.at);
  const end = read(
    notice(
      "turn/completed",
      v.object({
        threadId,
        turn: v.object({
          ...ids,
          status: v.literal("completed"),
          error: v.null(),
          startedAt: seconds,
          completedAt: seconds,
          items: v.strictTuple([
            v.object({
              ...finalItem.entries,
              startedAtMs: v.literal(assistant.at),
              completedAtMs: v.literal(final.completedAtMs),
            }),
          ]),
        }),
      }),
    ),
  ).params.turn;
  check(end.startedAt === startedAt && end.completedAt >= startedAt, "turn time");
  if (frames.length > seq) throw new Error(`Unexpected extra frame at line ${seq + 2}`);
  const updates = new Map<number, NativeUpdate>([
    [9, { kind: "start", root: nativeRootTurnId, at: startedAt }],
    [12, { kind: "toolStart", id: call.id, command: call.command }],
    [13, { kind: "toolDelta", id: call.id, text: output }],
    [
      14,
      { kind: "toolEnd", id: call.id, text: toolEnd.aggregatedOutput, exitCode: toolEnd.exitCode },
    ],
    [16, { kind: "delta", id: item, text: first }],
    [17, { kind: "delta", id: item, text: second }],
    [18, { kind: "final", id: item, text: final.text }],
    [19, { kind: "end", root: nativeRootTurnId, at: end.completedAt }],
  ]);
  return Object.freeze({
    expectedText,
    modelId,
    nativeSessionId,
    nativeRootTurnId,
    startedAt,
    endedAt: end.completedAt,
    frames: Object.freeze(
      frames.map((row) =>
        Object.freeze({ ...(updates.get(row.seq) ?? { kind: "internal" as const }), requestId }),
      ),
    ),
  });
}
