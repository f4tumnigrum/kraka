import type {
  EnvironmentId,
  ExecutorInstanceId,
  PrincipalId,
  PermissionMode,
  ProjectId,
  SignedRequest,
  ThreadId,
  AttemptId,
  ExecutorPrincipal,
} from "@kraka/protocol";
export type ParentToolScope = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  attemptId: AttemptId;
  instanceId: ExecutorInstanceId;
  principalId: PrincipalId;
  /** Resolve the intersection of parent, selected instance and target ceilings before dispatch. */
  childModeCeiling?: (
    item: Extract<SignedRequest, { method: "thread.launchChildren" }>["payload"]["items"][number],
  ) => PermissionMode | null;
  projects: ReadonlyMap<ProjectId, ReadonlySet<"shared" | "isolated">>;
};
const modeLevel = { ask: 0, edits: 1, open: 2 } satisfies Record<PermissionMode, number>;
/** Resolve the active scope on the host after method and grant checks. The parent's permission does not grant general access to any child project. */
export function permitsChildLaunch(
  active: ParentToolScope | null,
  principal: ExecutorPrincipal,
  request: Extract<SignedRequest, { method: "thread.launchChildren" }>,
): boolean {
  if (
    !active ||
    request.signer.kind !== "executor" ||
    request.signer.principalId !== principal.id ||
    active.principalId !== principal.id ||
    active.environmentId !== request.environmentId ||
    active.instanceId !== principal.executorInstanceId ||
    active.attemptId !== principal.attemptId ||
    active.threadId !== principal.threadId ||
    request.payload.threadId !== principal.threadId
  )
    return false;
  const items = request.payload.items;
  return (
    new Set(items.map((item) => item.childCommandId)).size === items.length &&
    items.every((item) => {
      if (!active.projects.get(item.projectId)?.has(item.checkout)) return false;
      if (item.requestedMode === undefined) return true;
      const ceiling = active.childModeCeiling?.(item);
      return ceiling != null && modeLevel[item.requestedMode] <= modeLevel[ceiling];
    })
  );
}
