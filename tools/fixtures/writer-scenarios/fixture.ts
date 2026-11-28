import type { createReplayAdapter, parseReplayRecording } from "@kraka/adapter-replay";
import type { WriterLifecycle } from "../../../packages/daemon/src/thread-work";
import type { RecoveryScope } from "@kraka/environment";
export type Scenario = (options: {
  state: string;
  root: string;
  point: string;
  adapter: ReturnType<typeof createReplayAdapter>;
  recording: ReturnType<typeof parseReplayRecording>;
}) => { lifecycle: WriterLifecycle; recovery?: RecoveryScope };
