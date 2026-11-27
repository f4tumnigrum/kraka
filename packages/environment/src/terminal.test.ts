import { test, expect } from "bun:test";
import * as v from "valibot";
import {
  REQUEST_METHODS,
  TerminalControlSchema,
  SubscriptionIdSchema,
  TerminalAddressSchema,
  TerminalGenerationSchema,
  TerminalOffsetSchema,
  TerminalSessionSchema,
} from "@kraka/protocol";
import {
  updateTerminalViewers,
  acceptsTerminalInput,
  effectiveTerminalSize,
  startTerminal,
  terminalGap,
  transitionTerminal,
  type TerminalEvent,
} from "./terminal";
const addr = v.parse(TerminalAddressSchema, {
  terminalId: "terminal",
  threadId: "thread",
  generation: "1",
});
const viewer = { ...addr, subscriptionId: v.parse(SubscriptionIdSchema, "viewer") };
const pos = (s: string) => v.parse(TerminalOffsetSchema, s);
const grid = { cols: 80, rows: 24 };

test("computes the exact byte debt of the slow viewer independently of the current head", () => {
  expect(
    terminalGap(viewer, pos("9007199254740993"), pos("9007199254741002"), pos("9007199254741100")),
  ).toMatchObject({
    ...viewer,
    kind: "terminal.gap",
    from: "9007199254740993",
    to: "9007199254741002",
    missingBytes: "9",
    head: "9007199254741100",
  });
  expect(terminalGap(viewer, pos("20"), pos("20"), pos("20"))).toBeNull();
});
test("recomputes columns and rows independently after the narrow or short viewer detaches", () => {
  const narrow = { cols: 60, rows: 50 },
    short = { cols: 120, rows: 20 };
  expect(effectiveTerminalSize([narrow, short], grid)).toEqual({ cols: 60, rows: 20 });
  expect(effectiveTerminalSize([short], grid)).toEqual(short);
  expect(effectiveTerminalSize([narrow], grid)).toEqual(narrow);
  expect(effectiveTerminalSize([], grid)).toEqual(grid);
  const second = v.parse(SubscriptionIdSchema, "other");
  const joined = updateTerminalViewers(new Map([[viewer.subscriptionId, narrow]]), grid, {
    kind: "attach",
    viewer: second,
    grid: short,
  });
  expect(joined.grid).toEqual({ cols: 60, rows: 20 });
  const left = updateTerminalViewers(joined.viewers, grid, { kind: "detach", viewer: second });
  expect(left.grid).toEqual(narrow);
  expect(
    updateTerminalViewers(left.viewers, grid, { kind: "resize", viewer: second, grid: short }).grid,
  ).toEqual(narrow);
});

test("after environment restart the old shell is gone and its history ends where the new shell starts a separate log", () => {
  let s = startTerminal(addr, grid);
  const step = (event: TerminalEvent) => {
    const r = transitionTerminal(s, event);
    if (r.kind === "rejected") throw new Error(r.reason);
    s = r.value;
  };
  step({ generation: addr.generation, kind: "started", process: { pid: 30, startedAt: 100 } });
  step({ generation: addr.generation, kind: "outputCommitted", from: pos("0"), to: pos("17") });
  step({ generation: addr.generation, kind: "processGone" });
  expect(s).toMatchObject({ kind: "lost", head: "17", reason: "environmentRestart" });
  const next = v.parse(TerminalGenerationSchema, "2");
  step({ generation: addr.generation, kind: "replace", nextGeneration: next, grid });
  step({ generation: next, kind: "started", process: { pid: 30, startedAt: 200 } });
  expect(v.parse(TerminalSessionSchema, s)).toMatchObject({
    kind: "running",
    generation: "2",
    head: "0",
    process: { startedAt: 200 },
    previous: {
      generation: "1",
      head: "17",
      process: { startedAt: 100 },
      reason: "environmentRestart",
    },
  });
  expect(
    transitionTerminal(s, {
      kind: "outputCommitted",
      generation: addr.generation,
      from: pos("0"),
      to: pos("1"),
    }).kind,
  ).toBe("rejected");
  expect(REQUEST_METHODS.writeTerminal.permission).toBe("term.input");
  expect(REQUEST_METHODS.attachTerminal.permission).toBe("term.view");
});

test("read permission alone or a stale control grant cannot submit terminal input", () => {
  const session = v.parse(TerminalSessionSchema, {
    ...addr,
    head: "0",
    previous: null,
    kind: "running",
    process: { pid: 10, startedAt: 123 },
    grid,
  });
  const control = v.parse(TerminalControlSchema, {
    ...viewer,
    environmentSessionId: "signed-session",
    lease: "grant",
  });
  expect(
    acceptsTerminalInput(
      session,
      control.environmentSessionId,
      new Set(["term.view"]),
      control,
      control,
    ),
  ).toBe(false);
  expect(
    acceptsTerminalInput(
      session,
      control.environmentSessionId,
      new Set(["term.input"]),
      control,
      control,
    ),
  ).toBe(true);
  expect(
    acceptsTerminalInput(session, control.environmentSessionId, new Set(["term.input"]), control, {
      ...control,
      generation: v.parse(TerminalGenerationSchema, "2"),
    }),
  ).toBe(false);
  expect(
    acceptsTerminalInput(
      session,
      control.environmentSessionId,
      new Set(["term.input"]),
      null,
      control,
    ),
  ).toBe(false);
});

test("an orderly environment shutdown can also replace its shell without erasing the previous generation", () => {
  const start = startTerminal(addr, grid);
  const closed = transitionTerminal(start, {
    generation: addr.generation,
    kind: "exit",
    code: null,
    signal: null,
    reason: "environmentStopped",
  });
  if (closed.kind !== "ok") throw new Error(closed.reason);
  const next = v.parse(TerminalGenerationSchema, "2");
  expect(
    transitionTerminal(closed.value, {
      generation: addr.generation,
      kind: "replace",
      nextGeneration: next,
      grid,
    }),
  ).toMatchObject({
    kind: "ok",
    value: { kind: "starting", generation: "2", previous: { generation: "1", head: "0" } },
  });
});
