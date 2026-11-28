import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import * as v from "valibot";

const object = (x: unknown) => v.parse(v.record(v.string(), v.unknown()), x);
export function controlledTurn(url: string, basic: string, write: (frame: unknown) => void) {
  const recordings = new Map<string, Record<string, unknown>[]>();
  function frame(name: string, seq: number) {
    let rows = recordings.get(name);
    if (!rows) {
      rows = readFileSync(join(dirname(basic), name + ".jsonl"), "utf8")
        .trim()
        .split("\n")
        .map((line) => object(JSON.parse(line)));
      recordings.set(name, rows);
    }
    const f = rows.find((row) => row.seq === seq);
    if (!f) throw Error("Missing recording frame " + seq);
    return object(f.frame);
  }
  let statePath = join(process.cwd(), "native-history.json");
  const stateSchema = v.object({
    session: v.string(),
    epoch: v.number(),
    turns: v.array(v.record(v.string(), v.unknown())),
  });
  const saved = () => v.parse(stateSchema, JSON.parse(readFileSync(statePath, "utf8")));
  let ws: WebSocket | undefined,
    epoch = 0,
    session = "",
    root = "",
    scenario = "",
    denied = false,
    callbackId: number | string = 4001,
    interrupt: number | null = null,
    replyOnInputClose = false;
  const note = (event: string, details: object = {}) =>
    ws?.send(JSON.stringify({ event, handle: process.pid, epoch, session, root, ...details }));
  function bound(name: string, seq: number) {
    const raw = frame(name, seq);
    const replace = (k: string, value: unknown) =>
      k === "threadId"
        ? session
        : k === "turnId" ||
            k === "rootTurnId" ||
            (k === "id" && typeof value === "string" && /^019b76da-abe8/.test(value))
          ? root
          : value;
    return object(JSON.parse(JSON.stringify(raw, replace)));
  }
  function end(outcome: string, publish: boolean) {
    const raw = bound(
      outcome === "interrupted" ? "interrupt" : "command-approval",
      outcome === "interrupted" ? 8 : 16,
    );
    const turn = {
      ...object(object(raw.params).turn),
      id: root,
      status: outcome,
      ...(outcome === "failed" ? { error: { message: "User declined the requested action" } } : {}),
    };
    const history = saved();
    history.turns = history.turns.filter((t) => t.id !== root);
    history.turns.push(turn);
    writeFileSync(statePath, JSON.stringify(history));
    if (publish) write({ method: "turn/completed", params: { threadId: session, turn } });
    note("root-ended", { outcome, published: publish });
  }
  function replyToInterrupt() {
    if (interrupt === null) throw Error("Missing interrupt");
    write({ ...bound("interrupt", 7), id: interrupt });
    note("interrupt-replied", { id: interrupt });
    interrupt = null;
  }
  function control(action: string) {
    if (action === "exit") {
      process.exit(19);
    }
    if (action === "hide-end") {
      end("completed", false);
      return;
    }
    if (action === "publish-before-interrupt-reply") {
      const turn = saved().turns.find((t) => t.id === root);
      if (!turn || interrupt === null) throw Error("Expected saved terminal and pending interrupt");
      replyOnInputClose = true;
      write({ method: "turn/completed", params: { threadId: session, turn } });
      return;
    }
    if (action === "interrupt-reply") {
      replyToInterrupt();
      return;
    }
    if (action === "stop") {
      end("interrupted", true);
      return;
    }
    if (action === "finish") {
      if (denied) {
        end("failed", true);
        return;
      }
      if (scenario === "resume") {
        for (const seq of [11, 12, 13]) write(bound("resume", seq));
      } else for (const seq of [10, 11, 12, 13, 14, 15]) write(bound("command-approval", seq));
      end("completed", true);
      return;
    }
    if (action === "handoff-approval") {
      callbackId = 4002;
      write({ ...bound("command-approval", 7), id: callbackId });
      note("callback-opened", { id: callbackId });
      return;
    }
    if (action === "callback") {
      const f = bound("command-approval", 7),
        params = object(f.params);
      if (scenario === "file") {
        callbackId = "4001";
        write({
          id: callbackId,
          method: "item/fileChange/requestApproval",
          params: { ...params, availableDecisions: ["accept", "decline"] },
        });
      } else if (scenario === "question" || scenario === "secret") {
        write({
          id: callbackId,
          method: "item/tool/requestUserInput",
          params: {
            ...params,
            itemId: "node-original",
            isBlocking: false,
            questions: [
              {
                id: "color",
                question: "Which color?",
                isSecret: scenario === "secret",
                options: [{ label: "blue" }, { label: "green" }],
              },
            ],
          },
        });
      } else write(f);
      note("callback-opened", { id: callbackId });
      return;
    }
    throw Error("Unexpected action " + action);
  }
  return {
    async open(method: string, params: Record<string, unknown>) {
      if (process.env.PEER_HISTORY_DIRECTORY) {
        session = method === "thread/resume" ? String(params.threadId) : crypto.randomUUID();
        if (!/^[a-f0-9-]+$/.test(session)) throw Error("Invalid fixture session");
        statePath = join(process.env.PEER_HISTORY_DIRECTORY, session + ".json");
      }
      if (method === "thread/resume") {
        const recorded = frame("resume", 4);
        const h = saved();
        session = h.session;
        if (recorded.method !== method || params.threadId !== session) throw Error("Wrong thread");
        epoch = h.epoch + 1;
        writeFileSync(statePath, JSON.stringify({ ...h, epoch }));
      } else {
        if (existsSync(statePath)) throw Error("New session replaced an existing conversation");
        session ||= String(object(frame("command-approval", 1).params).threadId);
        epoch = 1;
        writeFileSync(statePath, JSON.stringify({ session, epoch, turns: [] }));
      }
      ws = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        if (!ws) throw Error();
        ws.onopen = () => resolve();
        ws.onerror = () => reject(Error("Peer control socket"));
      });
      ws.onmessage = (e) => control(String(e.data));
      note(method === "thread/resume" ? "resume-complete" : "opened");
      return method === "thread/resume" && existsSync(statePath + ".mismatch")
        ? "unexpected-thread"
        : session;
    },
    async request(method: string, id: number, p: Record<string, unknown>) {
      if (p.threadId !== session) throw Error("Foreign native thread");
      if (method === "thread/rollback") {
        const h = saved();
        const count = v.parse(
          v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(h.turns.length)),
          p.numTurns,
        );
        h.turns.splice(-count);
        writeFileSync(statePath, JSON.stringify(h));
        note("rewound");
        write({ id, result: { thread: { id: session, turns: h.turns } } });
        return;
      }
      if (method === "thread/read") {
        write({ id, result: { thread: { id: session, turns: saved().turns } } });
        note("history-read");
        return;
      }
      if (method === "turn/interrupt") {
        if (bound("interrupt", 6).method !== method || p.turnId !== root)
          throw Error("Foreign interrupt");
        interrupt = id;
        note("interrupt-received", { id });
        return;
      }
      if (method === "turn/steer") {
        if (bound("steer", 6).method !== method || p.expectedTurnId !== root)
          throw Error("Foreign steer");
        write({ id, result: { ...object(bound("steer", 7).result), turnId: root } });
        note("steered", { input: p.input });
        return;
      }
      if (method !== "turn/start" || !Array.isArray(p.input)) throw Error("Unexpected request");
      scenario = String(object(p.input[0]).text);
      if (scenario === "unavailable") writeFileSync(statePath + ".mismatch", "mismatched result");
      const recording =
        scenario === "resume"
          ? "resume"
          : scenario === "interrupt"
            ? "interrupt"
            : scenario === "steer"
              ? "steer"
              : "command-approval";
      root = crypto.randomUUID();
      const start = recording === "resume" ? 7 : 2;
      const result = object(bound(recording, start).result);
      write({ id, result: { turn: { ...object(result.turn), id: root, rootTurnId: root } } });
      const begun = object(bound(recording, start + 1).params);
      write({
        method: "turn/started",
        params: { threadId: session, turn: { ...object(begun.turn), id: root, rootTurnId: root } },
      });
      if (recording === "command-approval") write(bound("command-approval", 6));
      note("turn", { text: scenario });
    },
    async reply(r: Record<string, unknown>) {
      if (r.id !== callbackId || !r.result) throw Error("Wrong callback reply");
      denied = object(r.result).decision === "decline";
      note("reply-written", { id: r.id, result: r.result });
      write({
        method: "serverRequest/resolved",
        params: { threadId: session, requestId: callbackId },
      });
    },
    close() {
      // The daemon closes this handle's stdin after it commits the natural root end.
      if (replyOnInputClose) replyToInterrupt();
      ws?.close();
    },
  };
}
