import type {
  EnvironmentId,
  ThreadId,
  RoundId,
  ObjectVersion,
  InputContent,
} from "@kraka/protocol";
/** Only the editing device owns this draft. A conflict survives until explicit recovery or dismissal. */
export type QueueEditDraft = {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  roundId: RoundId;
  baseVersion: ObjectVersion;
  content: InputContent;
} & ({ kind: "editing" } | { kind: "conflict"; currentVersion: ObjectVersion | null });
