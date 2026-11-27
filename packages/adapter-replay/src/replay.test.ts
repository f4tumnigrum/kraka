import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  AttemptIdSchema,
  DeliveryIdSchema,
  ExecutorInstanceIdSchema,
  MessageIdSchema,
  ReplayTurnUpdateSchema,
  ReplayRunRequestSchema,
  type CommandReceipt,
  type ReplayTurnUpdate,
} from "@kraka/protocol";
import { runReplayTurn, type AdapterCallResult } from "@kraka/environment";
import source from "../../../fixtures/executors/codex/basic-turn.jsonl" with { type: "text" };
import { createReplayAdapter, parseReplayRecording } from "./index";

function ok<T>(result: AdapterCallResult<T>) {
  if (result.kind !== "ok") throw new Error(result.reason);
  return result.value;
}
const recording = parseReplayRecording(source);
const instance = {
  family: "replay",
  instanceId: v.parse(ExecutorInstanceIdSchema, "replay"),
} as const;
test("a recording error identifies its physical line or the first missing line", () => {
  const lines = source.trimEnd().split("\n");
  const change = (seq: number, from: string, to: string) =>
    lines.map((row, i) => (i === seq ? row.replace(from, to) : row)).join("\n");
  for (const [input, diagnostic] of [
    ["", "EOF at line 1"],
    [lines[0] ?? "", "EOF at line 2"],
    [lines.slice(0, -1).join("\n"), "EOF at line 20"],
    [change(19, '"rootTurnId":"', '"rootTurnId":"foreign-'), "line 20"],
    [`${source.trimEnd()}\n${lines[19]?.replace('"seq":19', '"seq":20')}`, "line 21"],
    [change(13, '"fromExecutor"', '"toExecutor"'), "line 14"],
    [change(7, '"input":[', '"input":[],"wrong":['), "line 8"],
    [change(14, '"exitCode":0', '"exitCode":1.5'), "line 15"],
    [change(12, '"startedAtMs":1767225601250', '"startedAtMs":-1'), "line 13"],
    [change(18, "The marker was amber.", "changed"), "line 19"],
    [change(19, '"completedAt":1767225603', '"completedAt":1767225600'), "line 20"],
    [[...lines.slice(0, 7), "", ...lines.slice(7)].join("\n"), "line 8"],
  ] as const)
    expect(() => parseReplayRecording(input)).toThrow(diagnostic);
});

test("two opens consume the same recording independently and resume only from emitted cursors", async () => {
  const adapter = createReplayAdapter();
  const declaration = ok(await adapter.capabilities(instance));
  expect(Object.values(declaration.matrix).filter((v) => v.kind === "native")).toHaveLength(6);
  expect(declaration.checkedAt).toBe(recording.startedAt);
  const setup = {
    workingDirectory: ".",
    additionalDirectories: [],
    environment: {},
    model: { id: recording.modelId, options: {} },
    permission: { ceiling: "ask", selected: "ask" },
  } as const;
  const open = async () =>
    ok(
      await adapter.open({
        instance,
        setup,
        resume: null,
        attemptId: v.parse(AttemptIdSchema, crypto.randomUUID()),
      }),
    );
  const a = await open(),
    b = await open();
  const send = async (session: typeof a) =>
    ok(
      await adapter.invoke(
        session,
        {
          ...instance,
          capability: "submitTextInput",
          support: { kind: "native" },
          capabilityVersion: 1,
        },
        {
          kind: "deliverInput",
          capability: "submitTextInput",
          attemptId: session.handle.attemptId,
          deliveryId: v.parse(DeliveryIdSchema, crypto.randomUUID()),
          input: {
            id: v.parse(MessageIdSchema, "m"),
            text: recording.expectedText,
            attachments: [],
            references: [],
          },
        },
      ),
    );
  const read = (session: typeof a, after: string | null) =>
    adapter.events(session, after)[Symbol.asyncIterator]();
  try {
    await send(a);
    const stream = read(a, null);
    for (const id of ["9", "12", "13", "14"]) expect((await stream.next()).value?.eventId).toBe(id);
    await stream.return?.();
    for (const cursor of ["15", "16", "x"])
      await expect(read(a, cursor).next()).rejects.toThrow("cursor");
    await expect(read(b, "14").next()).rejects.toThrow("cursor");
    const end = [];
    for await (const event of adapter.events(a, "14")) end.push(event);
    expect(end.map((e) => e.eventId)).toEqual(["16", "17", "18", "19"]);
    expect(end.at(-1)?.payload).toMatchObject({
      endedAt: recording.endedAt,
      endTimeEvidence: {
        source: "executorReported",
        executorEndedAt: recording.endedAt,
        environmentObservedAt: null,
      },
    });
    const pending = read(b, null).next();
    await send(b);
    expect((await pending).value?.eventId).toBe("9");
  } finally {
    await adapter.close(a, "finished");
    await adapter.close(b, "shutdown");
  }
});

test("the public stream uses the actual fragments, final text and end time in the recording", async () => {
  const changed = parseReplayRecording(
    source
      .replaceAll("The marker was ", " Blue ")
      .replaceAll("amber.", "water.")
      .replaceAll('"completedAt":1767225603', '"completedAt":1767225607'),
  );
  const adapter = createReplayAdapter(changed);
  const observed: (CommandReceipt | ReplayTurnUpdate)[] = [];
  const endTimes: number[] = [];
  const events = adapter.events;
  adapter.events = async function* (session, after) {
    for await (const event of events(session, after)) {
      if (event.payload.kind === "roundEnded") {
        endTimes.push(event.payload.endedAt);
        expect(event.payload.endTimeEvidence).toEqual({
          source: "executorReported",
          executorEndedAt: 1767225607000,
          environmentObservedAt: null,
        });
      }
      yield event;
    }
  };
  await runReplayTurn({
    request: v.parse(ReplayRunRequestSchema, {
      kind: "replay.run",
      commandId: "run",
      permission: "ask",
      input: { text: changed.expectedText, attachments: [], references: [] },
    }),
    adapter,
    workingDirectory: ".",
    expectedText: changed.expectedText,
    modelId: changed.modelId,
    signal: new AbortController().signal,
    emit: (m) => observed.push(m),
  });
  expect(endTimes).toEqual([1767225607000]);
  expect(observed.slice(5, 8).map((m) => ("text" in m ? m.text : null))).toEqual([
    " Blue ",
    "water.",
    " Blue water.",
  ]);
  expect(observed[8]).toMatchObject({ endedAt: 1767225607000, phase: "closing" });
  for (const u of observed.slice(1))
    expect(v.safeParse(ReplayTurnUpdateSchema, u).success).toBe(true);
  for (const invalid of [
    { ...observed[5], streaming: false },
    { ...observed[1], phase: "closing" },
    { ...observed[8], extra: 1 },
  ])
    expect(v.safeParse(ReplayTurnUpdateSchema, invalid).success).toBe(false);
});
