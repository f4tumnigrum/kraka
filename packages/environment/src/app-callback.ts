import * as v from "valibot";
import { ObjectVersionSchema, type AppNote } from "@kraka/protocol";
import type {
  AppCallback,
  AppConfirmation,
  AppSource,
  CommandId,
  PrincipalId,
  PermissionItem,
} from "@kraka/protocol";
export type AppRuntime = {
  source: AppSource;
  tools: ReadonlyMap<string, { readOnly: boolean; permissions: readonly PermissionItem[] }>;
  resources: ReadonlySet<string>;
};
function sameSource(a: AppSource, b: AppSource) {
  return (
    a.environmentId === b.environmentId &&
    a.threadId === b.threadId &&
    a.itemId === b.itemId &&
    a.instanceId === b.instanceId &&
    a.sessionId === b.sessionId &&
    a.attemptId === b.attemptId &&
    a.generation === b.generation &&
    a.serviceId === b.serviceId
  );
}
/** Resolve the live runtime from the original item. The host supplies its own digest of the canonical action and rechecks rights before dispatch. */
export function checkAppCallback(
  callback: AppCallback,
  runtime: AppRuntime | null,
  commandId: CommandId,
  digest: string,
  owner: PrincipalId,
  granted: ReadonlySet<PermissionItem>,
  now: number,
  confirmation: AppConfirmation | null,
) {
  if (!runtime || !sameSource(runtime.source, callback.source)) return "sessionStopped";
  if (!granted.has("thread.view")) return "missingPermission";
  const action = callback.action;
  if (action.kind === "message" && !granted.has("thread.send")) return "missingPermission";
  if (action.kind === "resource")
    return runtime.resources.has(action.uri) ? "allowed" : "resourceUnavailable";
  if (action.kind === "tool") {
    const tool = runtime.tools.get(action.name);
    if (!tool) return "toolNotCallable";
    if (!tool.permissions.every((permission) => granted.has(permission)))
      return "missingPermission";
    if (tool.readOnly) return "allowed";
  }
  return confirmation &&
    confirmation.confirmedBy === owner &&
    sameSource(confirmation.source, runtime.source) &&
    confirmation.commandId === commandId &&
    confirmation.payloadDigest === digest &&
    confirmation.issuedAt <= now &&
    now < confirmation.expiresAt &&
    now - confirmation.issuedAt < 600_000
    ? "allowed"
    : "confirmationRequired";
}

/** A cleared note retains its last version. The store compares and commits that version in one transaction. */
export function editAppNote(
  key: AppNote["key"],
  prior: AppNote | null,
  expected: AppNote["version"] | null,
  text: string,
  at: number,
): AppNote | "conflict" | "tooLarge" {
  if (
    prior &&
    (prior.key.targetThreadId !== key.targetThreadId ||
      prior.key.source.environmentId !== key.source.environmentId ||
      prior.key.source.threadId !== key.source.threadId ||
      prior.key.source.itemId !== key.source.itemId)
  )
    return "conflict";
  if ((prior?.version ?? null) !== expected) return "conflict";
  if (new TextEncoder().encode(text).length > 16 * 1024) return "tooLarge";
  return {
    key,
    version: v.parse(ObjectVersionSchema, String(BigInt(expected ?? "0") + 1n)),
    updatedAt: at,
    text: text || null,
  };
}
