import * as v from "valibot";
import {
  ChildReceiptSchema,
  CommandIdSchema,
  DelegatedChildRecordSchema,
  WorktreeIdSchema,
  canonicalJson,
  type PermissionMode,
  type PermissionItem,
  type PrincipalId,
  type ProjectId,
  type SignedRequest,
  type CommandReceipt,
  type RequestResult,
  type Thread,
} from "@kraka/protocol";
import {
  acceptFirstInput,
  permitsChildLaunch,
  readRound,
  type AccessStore,
  type ExecutorToolGrant,
  type FirstSendStore,
  type LocalActor,
  type OrdinaryStops,
} from "@kraka/environment";
import type { ExecutorInstances, ExecutorSelection } from "./executor-instances";

type Launch = Extract<SignedRequest, { method: "thread.launchChildren" }>;
type Item = Launch["payload"]["items"][number];
type ChildCall = Launch | Extract<SignedRequest, { method: "thread.cancelChild" }>;
const levels: readonly PermissionMode[] = ["ask", "edits", "open"];
function lower(a: PermissionMode, b: PermissionMode) {
  return levels.indexOf(a) <= levels.indexOf(b) ? a : b;
}

export function delegatedWork(options: {
  store: FirstSendStore;
  access: AccessStore;
  executors: ExecutorInstances;
  stops: OrdinaryStops;
  owner: PrincipalId;
  parent: Thread;
  selection: ExecutorSelection;
  grant: ExecutorToolGrant;
}) {
  const { store, access, executors, stops, owner, parent, selection, grant } = options;
  const target = { kind: "project" as const, projectId: parent.projectId };
  const ceiling = (permission: PermissionItem) => access.ceiling(owner, target, permission);
  function choose(item: Item) {
    if (item.projectId !== parent.projectId) return null;
    const id =
      item.instanceId ?? executors.registry.defaultFor(item.projectId) ?? selection.reg.instanceId;
    const cwd = store.projectDirectory(item.projectId);
    const choice = cwd ? executors.select(executors.current(id, owner, cwd), item.model) : null;
    const project = ceiling("thread.send"),
      change = item.checkout === "isolated" ? ceiling("workspace.change") : project;
    const parentMode = access.ceiling(
      owner,
      { kind: "thread", threadId: parent.id },
      "thread.send",
    );
    if (!choice || !project || !change || !parentMode) return null;
    const limit = [project, change, parentMode, selection.sessionPermission.selected].reduce(
      lower,
      choice.snapshot.permission.ceiling,
    );
    const requestedMode = item.requestedMode ?? choice.snapshot.permission.selected;
    const effectiveMode = lower(limit, requestedMode);
    if (!choice.probe.declaration.permission.modes.includes(effectiveMode)) return null;
    return { choice, limit, requestedMode, effectiveMode };
  }
  return (request: ChildCall, actor: LocalActor): CommandReceipt | RequestResult => {
    const fail = (
      kind: "notFound" | "invalidState" | "idConflict" | "unsupported",
    ): CommandReceipt => ({ kind: "rejected", commandId: request.commandId, failure: { kind } });
    const children = store.services.childTransfers;
    if (request.method === "thread.cancelChild") {
      const child = children.status(request.payload.taskId, parent.id);
      if (!child) return fail("notFound");
      if (
        !["completed", "cancelled", "failed"].includes(child.state.kind) &&
        !children.cancelQueued(child.taskId, parent.id)
      ) {
        const original = children.forParent(child.taskId, parent.id);
        const round = original && readRound(store.db, original.childRoundId);
        if (!round) return fail("notFound");
        const commandId = v.parse(CommandIdSchema, crypto.randomUUID());
        const response = stops.command(
          {
            actor: {
              ...actor,
              allows: (right, t) =>
                right === "thread.send" && t.kind === "thread" && t.threadId === child.threadId,
            },
            transaction: store,
            commandId,
          },
          {
            method: "round.stop",
            commandId,
            payload: { threadId: child.threadId, attemptId: round.attempt.attemptId },
          },
        );
        if (response.kind === "rejected") return { ...response, commandId: request.commandId };
      }
      return { kind: "childStatus", child: children.status(child.taskId, parent.id) ?? child };
    }
    if (request.payload.mode !== "delegate") return fail("unsupported");
    const projects = new Map<ProjectId, Set<"shared" | "isolated">>();
    const allowed = new Set<"shared" | "isolated">();
    if (ceiling("thread.send")) {
      allowed.add("shared");
      if (ceiling("workspace.change")) allowed.add("isolated");
    }
    projects.set(parent.projectId, allowed);
    const choices = new Map<Item, NonNullable<ReturnType<typeof choose>>>();
    const seen = new Set<string>();
    for (const item of request.payload.items) {
      if (!projects.get(item.projectId)?.has(item.checkout)) return fail("notFound");
      if (seen.has(item.childCommandId) || item.childCommandId === request.commandId)
        return fail("idConflict");
      seen.add(item.childCommandId);
      const chosen = choose(item);
      if (!chosen) return fail("invalidState");
      choices.set(item, chosen);
    }
    if (
      !permitsChildLaunch(
        {
          environmentId: grant.environmentId,
          threadId: parent.id,
          attemptId: grant.principal.attemptId,
          instanceId: grant.binding.instanceId,
          principalId: actor.id,
          projects,
          childModeCeiling: (item) => choices.get(item)?.limit ?? null,
        },
        grant.principal,
        request,
      )
    )
      return fail("invalidState");
    const items: v.InferOutput<typeof ChildReceiptSchema>[] = [];
    for (const [item, chosen] of choices) {
      const prior = store.db
        .query<{ intent: string; receipt: string }, [string, string]>(
          "SELECT intent,receipt FROM child_launches WHERE parent=? AND command=?",
        )
        .get(parent.id, item.childCommandId);
      const intent = canonicalJson({ attemptId: grant.principal.attemptId, item });
      if (prior) {
        items.push(
          prior.intent === intent
            ? v.parse(ChildReceiptSchema, JSON.parse(prior.receipt))
            : { kind: "rejected", childCommandId: item.childCommandId, reason: "idConflict" },
        );
        continue;
      }
      const { choice, requestedMode, effectiveMode } = chosen;
      const first = acceptFirstInput({
        verifiedActor: {
          ...actor,
          allows: (right, t) =>
            t.kind === "project" &&
            t.projectId === item.projectId &&
            (right === "thread.send" ||
              (right === "workspace.change" && item.checkout === "isolated")),
        },
        transaction: store,
        commandId: item.childCommandId,
        threadStart: {
          projectId: item.projectId,
          worktreeId:
            item.checkout === "isolated" ? v.parse(WorktreeIdSchema, crypto.randomUUID()) : null,
          instanceId: choice.reg.instanceId,
          model: choice.model,
          content: { text: item.instruction, references: [], attachments: [] },
        },
        selected(round) {
          store.db.run("INSERT INTO round_executors VALUES(?,?,?,?)", [
            round,
            choice.reg.instanceId,
            choice.reg.version,
            JSON.stringify(choice.model),
          ]);
        },
      });
      let receipt: v.InferOutput<typeof ChildReceiptSchema>;
      if (first.kind === "accepted" && first.result.kind === "threadStarted") {
        const { threadId, roundId } = first.result;
        const child = v.parse(DelegatedChildRecordSchema, {
          taskId: crypto.randomUUID(),
          parentThreadId: parent.id,
          parentRoundId: grant.roundId,
          childCommandId: item.childCommandId,
          childThreadId: threadId,
          childRoundId: roundId,
          instanceId: choice.reg.instanceId,
          model: choice.model,
          requestedMode,
          effectiveMode,
          returnTransferId: crypto.randomUUID(),
          state: { kind: "queued" },
        });
        if (children.accept(child) !== "stored")
          throw Error("Child receipt conflicts with its original task");
        receipt = {
          kind: "accepted",
          taskId: child.taskId,
          childCommandId: item.childCommandId,
          threadId,
          roundId,
        };
      } else
        receipt = {
          kind: "rejected",
          childCommandId: item.childCommandId,
          reason: first.kind === "rejected" ? first.failure.kind : "invalidState",
        };
      store.db.run(
        "INSERT INTO child_launches(parent,command,intent,owner,child,receipt) VALUES(?,?,?,?,?,?)",
        [
          parent.id,
          item.childCommandId,
          intent,
          owner,
          receipt.kind === "accepted" ? receipt.threadId : null,
          JSON.stringify(receipt),
        ],
      );
      items.push(receipt);
    }
    return { kind: "childrenAccepted", items };
  };
}
