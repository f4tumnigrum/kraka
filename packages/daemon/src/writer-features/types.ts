import type { FirstSendStore, Managed } from "@kraka/environment";
import type { CommandId, Round, ThreadId } from "@kraka/protocol";
export interface RecoveryContext {
  store: FirstSendStore;
  replay: boolean;
  inspections: Map<ThreadId, Round[]>;
  resume(claim: Managed): unknown;
  schedule(thread: ThreadId, command: CommandId): void;
}
export interface WriterFeature {
  open?(store: FirstSendStore): { services: object; close?: () => Promise<void> };
  register?(context: RecoveryContext): void | (() => void);
  draining?(store: FirstSendStore): Iterable<Promise<unknown>>;
}
