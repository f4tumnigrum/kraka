// Live cases 5; required groups ["1.", "2.", "3.", "4.", "5."]
import { expect, test } from "bun:test";
import * as v from "valibot";
import {
  ChildResultTransferSchema,
  DelegatedChildRecordSchema,
  type DelegatedChildRecord,
} from "@kraka/protocol";
import { readThread, readRound } from "@kraka/environment";
import { accepted } from "../fixtures/first-send";
import {
  fixtureGit,
  id,
  toolScenario,
  type ToolScenario,
} from "../fixtures/executor-tools-scenario";

type Parent = Awaited<ReturnType<ToolScenario["start"]>>;
const item = (f: ToolScenario, instruction: string) => ({
  childCommandId: id(),
  projectId: f.project.id,
  instruction,
  checkout: "shared" as const,
});
async function launch(f: ToolScenario, parent: Parent, instruction = "child") {
  const result = accepted(
    await f.callTool(parent.attemptId, "launchChildren", {
      threadId: parent.threadId,
      mode: "delegate",
      items: [item(f, instruction)],
    }),
    "childrenAccepted",
  );
  const child = result.items[0];
  if (child?.kind !== "accepted") throw Error("Expected a child receipt");
  const round = f.read((db) => readRound(db, child.roundId));
  if (!round) throw Error("Missing recorded child round");
  await f.until("start", { attempt: round.attempt.attemptId });
  return { ...child, attempt: round.attempt.attemptId };
}
function savedChild(f: ToolScenario, task: string) {
  return f.read((db) => {
    const row = db
      .query<{ data: string }, [string]>("SELECT data FROM delegated_children WHERE task=?")
      .get(task);
    if (!row) throw Error("Missing child record");
    return v.parse(DelegatedChildRecordSchema, JSON.parse(row.data));
  });
}
function transfer(f: ToolScenario, child: DelegatedChildRecord) {
  return f.read((db) => {
    const row = db
      .query<{ data: string }, [string]>("SELECT data FROM child_result_transfers WHERE id=?")
      .get(child.returnTransferId);
    if (!row) throw Error("Missing child result");
    return v.parse(ChildResultTransferSchema, JSON.parse(row.data));
  });
}
test(
  "1. Checkout and attempt (J-2.1)",
  async () =>
    toolScenario(async (f) => {
      const first = await f.start("first"),
        other = await f.start("other");
      const rpc = await f.executorSocket(first.attemptId, first.threadId);
      expect(
        accepted(
          await rpc.client.rpc("thread.inspectCheckout", { threadId: first.threadId }),
          "checkoutObserved",
        ).checkout,
      ).toMatchObject({ kind: "available", shared: true });
      expect(
        await rpc.client.rpc("thread.rename", { threadId: first.threadId, title: "forbidden" }),
      ).toMatchObject({ failure: { kind: "unsupported" } });
      const root = fixtureGit(f.cwd, "rev-parse", "HEAD");
      for (const task of [first, other, await f.start("isolated", true)]) {
        const response = accepted(
          await f.callTool(task.attemptId, "inspectCheckout", { threadId: task.threadId }),
          "checkoutObserved",
        );
        const row = f.read((db) => readThread(db, task.threadId));
        expect(response.checkout).toMatchObject({
          kind: "available",
          binding: row?.directory,
          shared: task === first || task === other,
        });
        if (response.checkout.kind !== "available") throw Error("Checkout missing");
        const path = response.checkout.path;
        expect(fixtureGit(path, "rev-parse", "HEAD")).toBe(root);
        const branch = fixtureGit(path, "branch", "--show-current");
        if (!row?.worktreeId) {
          expect(branch).toBe("main");
          expect(f.project.root?.realPath).toBe(path);
        } else {
          expect(path).not.toBe(f.project.root?.realPath);
          expect(branch).toMatch(/^kraka\/wt-/);
        }
      }
      const bad = await f.callTool(first.attemptId, "inspectCheckout", {
        threadId: other.threadId,
      });
      expect(bad).toEqual({
        kind: "rejected",
        commandId: bad.commandId,
        failure: { kind: "notFound" },
      });
      const input = {
        threadId: other.threadId,
        content: { text: "from executor", references: [], attachments: [] },
      };
      const command = id();
      const sent = accepted(
        await f.callTool(other.attemptId, "sendInput", input, command),
        "inputScheduled",
      );
      expect(
        accepted(await f.callTool(other.attemptId, "sendInput", input, command), "inputScheduled"),
      ).toEqual(sent);
      const upload = {
        transferId: crypto.randomUUID(),
        attachmentId: crypto.randomUUID(),
        byteLength: 3,
        mediaType: "text/plain",
        target: { kind: "thread", threadId: other.threadId },
      };
      const prepare = id();
      const opened = accepted(
        await f.callTool(other.attemptId, "prepareAttachment", upload, prepare),
        "contentTransferOpened",
      );
      expect(
        accepted(
          await f.callTool(other.attemptId, "prepareAttachment", upload, prepare),
          "contentTransferOpened",
        ),
      ).toEqual(opened);
      expect(await f.callTool(other.attemptId, "sendInput", input, prepare)).toMatchObject({
        failure: { kind: "idConflict" },
      });
      const observer = await f.device("owner", first.threadId);
      await f.control("finish", { attempt: first.attemptId, text: "done" });
      await observer.until(
        () =>
          Object.values(observer.cache.read().rows).some(
            (r) =>
              r.row?.objectType === "round" &&
              r.row.value.id === first.roundId &&
              r.row.value.attempt.phase.kind === "finished",
          ),
        "parent end seal",
      );
      const next = await f.input(first.threadId, "successor");
      await f.until("start", { attempt: next.attemptId });
      const stale = await f.callTool(first.attemptId, "inspectCheckout", {
        threadId: first.threadId,
      });
      expect(stale).toEqual({
        kind: "rejected",
        commandId: stale.commandId,
        failure: { kind: "expired" },
      });
    }),
  90000,
);

test(
  "2. Batch scope and defaults",
  async () =>
    toolScenario(async (f) => {
      const parent = await f.start("parent"),
        caller = parent.attemptId,
        threadId = parent.threadId;
      const batch = {
        mode: "delegate",
        threadId,
        items: [
          {
            ...item(f, "explicit"),
            instanceId: "secondary",
            model: { id: "model-b", options: { effort: "high" } },
            requestedMode: "ask",
          },
          item(f, "default"),
        ],
      };
      await f.device("owner", threadId);
      const count = () => f.log.items.filter((x) => x.event === "start").length,
        initial = count();
      for (const items of [
        [batch.items[0], { ...batch.items[1], projectId: "foreign" }],
        [batch.items[0], batch.items[0]],
        [{ ...batch.items[0], requestedMode: "open" }],
      ]) {
        const denied = await f.callTool(caller, "launchChildren", { ...batch, items });
        expect(denied.kind).toBe("rejected");
        await f.control("fence");
        expect(count()).toBe(initial);
      }
      const cmd = id(),
        result = accepted(
          await f.callTool(caller, "launchChildren", batch, cmd),
          "childrenAccepted",
        );
      expect(result.items).toHaveLength(2);
      for (const [i, child] of result.items.entries()) {
        if (child.kind !== "accepted") throw Error("Missing accepted child");
        const row = savedChild(f, child.taskId),
          round = f.read((db) => readRound(db, child.roundId));
        if (!round) throw Error("Missing child round");
        const opened = await f.until("open", { attempt: round.attempt.attemptId });
        expect(row).toMatchObject({
          childCommandId: child.childCommandId,
          parentThreadId: threadId,
          parentRoundId: parent.roundId,
          childThreadId: child.threadId,
          childRoundId: child.roundId,
        });
        expect(opened.instanceId).toBe(i ? "primary" : "secondary");
        expect(opened.setup).toMatchObject({
          model: row.model,
          permission: { selected: row.effectiveMode },
        });
        expect(row.model).toEqual(
          i ? { id: "model-a", options: {} } : { id: "model-b", options: { effort: "high" } },
        );
        await f.until("start", { attempt: round.attempt.attemptId });
      }
      await f.config("secondary", "model-a", "1");
      await f.control("default", { project: f.project.id, instance: "secondary" });
      expect(
        accepted(await f.callTool(caller, "launchChildren", batch, cmd), "childrenAccepted"),
      ).toEqual(result);
      const conflict = await f.callTool(
        caller,
        "launchChildren",
        { ...batch, items: [item(f, "changed")] },
        cmd,
      );
      expect(conflict).toMatchObject({ kind: "rejected", failure: { kind: "idConflict" } });
      await f.control("fence");
      expect(count()).toBe(initial + 2);
      const latest = await launch(f, parent, "new default");
      expect(savedChild(f, latest.taskId)).toMatchObject({
        instanceId: "secondary",
        model: { id: "model-a", options: {} },
      });
      const cancel = id(),
        target = { threadId, taskId: latest.taskId };
      const first = accepted(
        await f.callTool(caller, "cancelChild", target, cancel),
        "childStatus",
      );
      await f.until("stop", { attempt: latest.attempt });
      expect(
        accepted(await f.callTool(caller, "cancelChild", target, cancel), "childStatus"),
      ).toEqual(first);
      await f.control("fence");
      expect(
        f.log.items.filter((x) => x.event === "stop" && x.attempt === latest.attempt),
      ).toHaveLength(1);
    }),
  90000,
);

test(
  "3. Child waits for its owner (S-WORK-041)",
  async () =>
    toolScenario(async (f) => {
      const parent = await f.start("parent"),
        child = await launch(f, parent);
      const device = await f.device("owner", child.threadId);
      const untilTodo = async (kind: string) => {
        const read = () =>
          Object.values(device.cache.read().rows)
            .map((r) => r.row)
            .find((r) => r?.objectType === "todoRequest" && r.value.body.kind === kind);
        await device.until(() => !!read(), "sealed " + kind);
        const row = read();
        if (row?.objectType !== "todoRequest") throw Error("Missing request");
        return row.value;
      };
      const status = { threadId: parent.threadId, taskId: child.taskId };
      const waiting = f.callTool(parent.attemptId, "readChild", { ...status, waitMs: 45000 });
      await f.control("approval", { attempt: child.attempt, text: "" });
      const todo = await untilTodo("approval");
      expect(accepted(await waiting, "childStatus").child.state).toEqual({
        kind: "waitingApproval",
        requestId: todo.id,
        roundId: child.roundId,
      });
      const target = { threadId: child.threadId, todoRequestId: todo.id };
      const answers = [{ questionKey: "title", answer: "yes" }];
      const denied = await f.callTool(parent.attemptId, "answerQuestion", {
        ...target,
        threadId: parent.threadId,
        answers,
      });
      expect(denied).toMatchObject({ kind: "rejected" });
      expect((await f.callTool(child.attempt, "readAnswer", target)).kind).toBe("rejected");
      await f.control("fence");
      expect(f.log.items.filter((x) => x.event === "reply")).toHaveLength(0);
      const [attempt, decision] = await Promise.all([
        f.callTool(child.attempt, "answerQuestion", { ...target, answers }),
        device.client.rpc("todo.decide", {
          ...target,
          decision: { kind: "approval", choiceKey: "allow", scope: "once", decision: "allow" },
        }),
      ]);
      expect(attempt.kind).toBe("rejected");
      accepted(decision, "todoAnswerStored");
      expect(
        accepted(await device.client.rpc("todo.readAnswer", target), "todoAnswerRead").content,
      ).toMatchObject({ kind: "approval", decision: "allow" });
      await f.until("reply", { attempt: child.attempt });
      expect(f.log.items.filter((x) => x.event === "reply")).toHaveLength(1);
      await f.control("question", { attempt: child.attempt, text: "" });
      const question = await untilTodo("question");
      const q = { threadId: child.threadId, todoRequestId: question.id };
      accepted(
        await f.callTool(child.attempt, "answerQuestion", { ...q, answers }),
        "todoAnswerStored",
      );
      const answer = accepted(await device.client.rpc("todo.readAnswer", q), "executorAnswerRead");
      expect(answer.executor).toMatchObject({ threadId: child.threadId, attemptId: child.attempt });
      expect(
        accepted(await f.callTool(child.attempt, "readAnswer", q), "executorAnswerRead"),
      ).toEqual(answer);
    }),
  90000,
);

async function crashAt(stop: "childSettled" | "parentMessageCommitted" | "returnCommitted") {
  await toolScenario(async (f) => {
    const parent = await f.start("parent"),
      child = await launch(f, parent);
    const originalParent = await f.device("owner", parent.threadId);
    await f.control("finish", { attempt: parent.attemptId, text: "parent finished" });
    await originalParent.until(
      () =>
        Object.values(originalParent.cache.read().rows).some(
          (r) =>
            r.row?.objectType === "round" &&
            r.row.value.id === parent.roundId &&
            r.row.value.attempt.phase.kind === "finished",
        ),
      "sealed original parent round",
    );
    const text = "original result";
    await f.control("finish", { attempt: child.attempt, text });
    const boundary = await f.until(stop);
    const original = savedChild(f, child.taskId);
    expect(original.state).toEqual({ kind: "completed", result: text });
    const before = transfer(f, original);
    expect(before).toMatchObject({ version: stop === "returnCommitted" ? "2" : "1" });
    await f.restart(true);
    const next = await f.input(parent.threadId, "next parent round");
    expect(next.roundId).not.toBe(parent.roundId);
    await Promise.all([
      f.control("release"),
      f.control("return", { transferId: before.id }),
      f.control("return", { transferId: before.id }),
    ]);
    expect(
      await Promise.all([
        f.control("replay", { taskId: child.taskId }),
        f.control("conflict", { transferId: before.id }),
      ]),
    ).toEqual(["unchanged", "conflict"]);
    const winner = transfer(f, original);
    if (winner.state.kind !== "returned") throw Error("Expected returned transfer");
    expect(winner).toMatchObject({ version: "2", result: text, parentRoundId: parent.roundId });
    if (boundary.parentMessageId)
      expect({ id: boundary.parentMessageId, at: boundary.returnedAt }).toEqual({
        id: winner.state.parentMessageId,
        at: winner.state.returnedAt,
      });
    if (before.state.kind === "returned") expect(winner).toEqual(before);
    for (const who of ["owner", "mobile"] as const) {
      const dev = await f.device(who, parent.threadId);
      const result = () =>
        Object.values(dev.cache.read().childTransfers ?? {}).find(
          (t) => t.id === original.returnTransferId,
        );
      await dev.until(() => result()?.state.kind === "returned", "sealed parent return");
      expect(result()).toEqual(winner);
      const messages = Object.values(dev.cache.read().rows)
        .map((r) => r.row)
        .filter((r) => r?.objectType === "message" && r.value.text === text);
      expect(messages).toHaveLength(1);
      expect(messages[0]?.value).toMatchObject({
        id: winner.state.parentMessageId,
        threadId: parent.threadId,
        roundId: parent.roundId,
      });
    }
    const receipts = f.read((db) =>
      db
        .query("SELECT frozen FROM deliveries WHERE json_extract(frozen,'$.input.id')=?")
        .all(winner.state.kind === "returned" ? winner.state.parentMessageId : ""),
    );
    expect(receipts).toEqual([]);
  }, stop);
}
test("4. Restart after child settlement", () => crashAt("childSettled"), 90000);
test("5. Restart after parent commit", async () => {
  await crashAt("parentMessageCommitted");
  await crashAt("returnCommitted");
}, 150000);
